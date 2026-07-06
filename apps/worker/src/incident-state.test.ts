import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DB,
  INCIDENT_ACTIVE_STATES,
  INCIDENT_CLOSED_STATES,
  buildAgentRunIncidentPatch,
  createIncidentLifecycle,
  isActiveIncidentState,
  mergeIncidentsInTx,
  schema,
} from "@superlog/db";
import { completedResolutionReason } from "./incident-result-policy.js";

type RecordedCall =
  | { op: "insert.returning"; table: unknown; values: Record<string, unknown> }
  | { op: "insert.onConflictDoNothing"; table: unknown; values: Record<string, unknown> }
  | { op: "update.where"; table: unknown; values: Record<string, unknown> }
  | { op: "transaction.begin" }
  | { op: "transaction.end" };

function recordingDb(
  opts: {
    latestAgentRunId?: string | null;
    insertReturningRow?: Record<string, unknown>;
    updateReturningRows?: Record<string, unknown>[];
    incidentIssueLinks?: schema.IncidentIssue[];
    currentIssues?: Array<Record<string, unknown>>;
  } = {},
): {
  db: DB;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const insertChain = (table: unknown) => ({
    values(values: Record<string, unknown>) {
      return {
        async onConflictDoNothing() {
          calls.push({ op: "insert.onConflictDoNothing", table, values });
        },
        async returning() {
          calls.push({ op: "insert.returning", table, values });
          return [opts.insertReturningRow ?? { id: "created-id", ...values }];
        },
      };
    },
  });
  const updateChain = (table: unknown) => ({
    set(values: Record<string, unknown>) {
      const record = () => calls.push({ op: "update.where" as const, table, values });
      return {
        where(_cond: unknown) {
          record();
          return {
            async returning() {
              return opts.updateReturningRows ?? [{ id: "updated-id" }];
            },
          };
        },
      };
    },
  });
  const db = {
    insert: insertChain,
    update: updateChain,
    delete(_table: unknown) {
      return { async where() {} };
    },
    // Raw SQL surface used by listCurrentIssuesForIncidentInTx and the merge
    // repoint. Return the current issues' ids so the resolve cascade runs.
    async execute() {
      return (opts.currentIssues ?? []).map((issue) => ({ id: issue.id }));
    },
    query: {
      agentRuns: {
        async findFirst() {
          return opts.latestAgentRunId === undefined ? undefined : { id: opts.latestAgentRunId };
        },
      },
      incidentIssues: {
        async findMany() {
          return opts.incidentIssueLinks ?? [];
        },
      },
      issues: {
        async findMany() {
          return opts.currentIssues ?? [];
        },
      },
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      calls.push({ op: "transaction.begin" });
      const result = await fn(db);
      calls.push({ op: "transaction.end" });
      return result;
    },
  } as unknown as DB;
  return { db, calls };
}

function lastIncidentUpdate(calls: RecordedCall[]): Record<string, unknown> {
  const updates = calls.filter(
    (c): c is Extract<RecordedCall, { op: "update.where" }> =>
      c.op === "update.where" && c.table === schema.incidents,
  );
  assert.ok(updates.length > 0, "expected an incident update");
  const latest = updates.at(-1);
  assert.ok(latest);
  return latest.values;
}

function incidentUpdates(calls: RecordedCall[]): Record<string, unknown>[] {
  return calls
    .filter(
      (c): c is Extract<RecordedCall, { op: "update.where" }> =>
        c.op === "update.where" && c.table === schema.incidents,
    )
    .map((call) => call.values);
}

function eventsOfKind(calls: RecordedCall[], kind: string): Record<string, unknown>[] {
  return calls
    .filter(
      (c): c is Extract<RecordedCall, { op: "insert.onConflictDoNothing" }> =>
        c.op === "insert.onConflictDoNothing" && c.table === schema.incidentEvents,
    )
    .map((c) => c.values)
    .filter((v) => v.kind === kind);
}

function eventOfKind(calls: RecordedCall[], kind: string): Record<string, unknown> {
  const events = eventsOfKind(calls, kind);
  assert.equal(events.length, 1, `expected exactly one ${kind} event`);
  const event = events[0];
  assert.ok(event);
  return event;
}

function eventInsert(calls: RecordedCall[]): Record<string, unknown> {
  const events = calls.filter(
    (c): c is Extract<RecordedCall, { op: "insert.onConflictDoNothing" }> =>
      c.op === "insert.onConflictDoNothing" && c.table === schema.incidentEvents,
  );
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event);
  return event.values;
}

test("incident active state helper only treats open as active", () => {
  assert.equal(isActiveIncidentState("open"), true);
  assert.equal(isActiveIncidentState("resolved"), false);
  assert.equal(isActiveIncidentState("autoresolved_noise"), false);
  assert.equal(isActiveIncidentState("merged"), false);
});

test("incident active and closed sets partition the ADR-2 states", () => {
  const all = [...INCIDENT_ACTIVE_STATES, ...INCIDENT_CLOSED_STATES];
  assert.deepEqual([...all].sort(), ["autoresolved_noise", "merged", "open", "resolved"]);
  assert.equal(new Set(all).size, all.length);
});

test("createOpen creates a new open incident", async () => {
  const firstSeen = new Date(1_000);
  const lastSeen = new Date(2_000);
  const { db, calls } = recordingDb({
    insertReturningRow: {
      id: "inc-created",
      projectId: "proj-1",
      service: "api",
      title: "Created incident",
      codename: "steady-signal",
      status: "open",
      firstSeen,
      lastSeen,
      issueCount: 0,
    },
  });
  const lifecycle = createIncidentLifecycle(db);

  const incident = await lifecycle.createOpen({
    projectId: "proj-1",
    service: "api",
    title: "Created incident",
    firstSeen,
    lastSeen,
  });

  assert.equal(incident.status, "open");
  const insert = calls.find(
    (c): c is Extract<RecordedCall, { op: "insert.returning" }> =>
      c.op === "insert.returning" && c.table === schema.incidents,
  );
  assert.ok(insert);
  assert.equal(insert.values.status, "open");
  assert.equal(insert.values.issueCount, 0);
});

test("pure incident domain records the noise verdict without closing the incident itself", () => {
  const now = new Date(1_234);
  const patch = buildAgentRunIncidentPatch({
    incident: makeIncident("open"),
    agentRunId: "run-1",
    now,
    result: {
      state: "complete",
      summary: "Noise, not customer impact.",
      proposedTitle: " Noisy error ",
      severity: "SEV-3",
      noiseClassification: {
        reason: "confusing_log_no_impact",
        evidence: "Recovered immediately.",
      },
    },
  });

  assert.equal(patch.noiseResolved, true);
  assert.equal(patch.noiseReason, "confusing_log_no_impact");
  // The status flip now happens via resolveIncident (with the issue outcome
  // applied to linked issues), not through this patch.
  assert.equal(patch.updates.status, undefined);
  assert.equal(patch.updates.noiseReason, "confusing_log_no_impact");
  assert.equal(patch.updates.title, "Noisy error");
  assert.equal(patch.updates.noiseResolvedAt, now);
});

test("pure incident domain supports open-to-open metadata updates without closing", () => {
  const patch = buildAgentRunIncidentPatch({
    incident: makeIncident("open"),
    agentRunId: "run-1",
    result: {
      state: "complete",
      summary: "Action needed, but no automated patch.",
      proposedTitle: "Better incident title",
      severity: "SEV-2",
    },
  });

  assert.equal(patch.noiseResolved, false);
  assert.equal(patch.noiseReason, null);
  assert.equal(patch.updates.status, undefined);
  assert.equal(patch.updates.title, "Better incident title");
  assert.equal(patch.updates.agentSummary, "Action needed, but no automated patch.");
});

test("agent PR result records metadata but leaves the incident open until PR merge webhook", () => {
  const patch = buildAgentRunIncidentPatch({
    incident: makeIncident("open"),
    agentRunId: "run-1",
    result: {
      state: "complete",
      summary: "Opened a patch.",
      pr: {
        selectedRepoFullName: "org/repo",
        baseBranch: "main",
        validationPassed: true,
        openStatus: "opened",
        url: "https://github.com/org/repo/pull/1",
      } as schema.AgentRunPr,
    },
  });

  assert.equal(patch.updates.status, undefined);
  assert.equal(patch.noiseResolved, false);
  assert.equal(patch.updates.agentSummary, "Opened a patch.");
});

test("agent resolution classification is recognized for the resolve path", () => {
  assert.equal(
    completedResolutionReason({
      state: "complete",
      summary: "Upstream recovered.",
      resolutionClassification: {
        reason: "upstream_recovered",
        evidence: "No failures after provider recovery.",
      },
    }),
    "upstream_recovered",
  );
  assert.equal(
    completedResolutionReason({
      state: "complete",
      summary: "Transient condition cleared.",
      resolutionClassification: {
        reason: "transient_condition_cleared",
        evidence: "Retries are clean.",
      },
    }),
    "transient_condition_cleared",
  );
});

test("agent noise result records the verdict and noise event but leaves status to the resolve path", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createIncidentLifecycle(db);

  const outcome = await lifecycle.applyAgentRunResult({
    incident: makeIncident("open"),
    agentRunId: "run-1",
    result: {
      state: "complete",
      summary: "The signal is noisy.",
      proposedTitle: "False-positive error log",
      severity: "SEV-3",
      noiseClassification: {
        reason: "confusing_log_no_impact",
        evidence: "the operation recovered",
      },
    },
  });

  assert.deepEqual(outcome, { updated: true, noiseResolved: true });
  const update = lastIncidentUpdate(calls);
  assert.equal(update.status, undefined);
  assert.equal(update.title, "False-positive error log");
  assert.equal(update.agentSummary, "The signal is noisy.");
  assert.equal(update.noiseReason, "confusing_log_no_impact");
  const event = eventInsert(calls);
  assert.equal(event.kind, "incident_noise_classified");
  assert.equal(event.agentRunId, "run-1");
});

test("agent metadata update on open incident records findings without a noise event", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createIncidentLifecycle(db);

  const outcome = await lifecycle.applyAgentRunResult({
    incident: makeIncident("open"),
    agentRunId: "run-1",
    result: {
      state: "complete",
      summary: "Manual action needed.",
      proposedTitle: "Needs a human fix",
      severity: "SEV-1",
    },
  });

  assert.deepEqual(outcome, { updated: true, noiseResolved: false });
  const update = lastIncidentUpdate(calls);
  assert.equal(update.status, undefined);
  assert.equal(update.title, "Needs a human fix");
  assert.equal(update.agentSummary, "Manual action needed.");
  assert.equal(
    calls.filter((c) => c.op === "insert.onConflictDoNothing").length,
    0,
    "open-to-open metadata updates should not emit closed-state events",
  );
});

test("resolve closes only open incidents, cascades linked issue count, and emits an event", async () => {
  const resolvedAt = new Date(3_000);
  const { db, calls } = recordingDb({
    updateReturningRows: [{ id: "inc-1" }],
    currentIssues: [
      { id: "issue-1", title: "boom one", eventCount: 3 },
      { id: "issue-2", title: "boom two", eventCount: 5 },
    ],
  });
  const lifecycle = createIncidentLifecycle(db);

  const result = await lifecycle.resolve({
    incidentId: "inc-1",
    kind: "agent_classification",
    reasonCode: "upstream_recovered",
    reasonText: "Provider recovered.",
    agentRunId: "run-1",
    resolvedAt,
    eventSummary: "Incident resolved because upstream recovered.",
    eventDedupeKey: "resolved:run-1",
  });

  assert.deepEqual(result, { resolved: true, resolvedIssueCount: 2 });
  const update = lastIncidentUpdate(calls);
  assert.equal(update.status, "resolved");
  assert.equal(update.resolvedAt, resolvedAt);
  assert.equal(update.resolvedByKind, "agent_classification");
  assert.equal(update.resolvedReasonCode, "upstream_recovered");
  const resolvedEvent = eventOfKind(calls, "incident_resolved");
  assert.equal(resolvedEvent.agentRunId, "run-1");
  assert.equal((resolvedEvent.detail as Record<string, unknown>).resolvedIssueCount, 2);
  // Every issue in the default outcome gets marked resolved with its own event.
  const issueUpdates = calls.filter(
    (c): c is Extract<RecordedCall, { op: "update.where" }> =>
      c.op === "update.where" && c.table === schema.issues,
  );
  assert.equal(issueUpdates.length, 2);
  assert.equal(issueUpdates[0]?.values.status, "resolved");
  assert.equal(eventsOfKind(calls, "issue_resolved").length, 2);
});

test("resolve with a silence outcome silences the current issues", async () => {
  const { db, calls } = recordingDb({
    updateReturningRows: [{ id: "inc-1" }],
    currentIssues: [{ id: "issue-1", title: "boom", eventCount: 3 }],
  });
  const lifecycle = createIncidentLifecycle(db);

  await lifecycle.resolve({
    incidentId: "inc-1",
    kind: "dashboard_manual",
    reasonCode: "not_an_issue",
    reasonText: null,
    issueOutcome: { kind: "silence" },
  });

  const issueUpdate = calls.find(
    (c): c is Extract<RecordedCall, { op: "update.where" }> =>
      c.op === "update.where" && c.table === schema.issues,
  );
  assert.ok(issueUpdate);
  assert.equal(issueUpdate.values.status, "silenced");
  assert.ok(issueUpdate.values.silencedAt);
  assert.equal(eventsOfKind(calls, "issue_silenced").length, 1);
});

test("resolve is idempotent when the incident is no longer open", async () => {
  const { db, calls } = recordingDb({ updateReturningRows: [] });
  const lifecycle = createIncidentLifecycle(db);

  const result = await lifecycle.resolve({
    incidentId: "inc-1",
    kind: "slack_manual",
    reasonCode: "manual",
    reasonText: null,
  });

  assert.deepEqual(result, { resolved: false, resolvedIssueCount: 0 });
  assert.equal(
    calls.filter((c) => c.op === "insert.onConflictDoNothing").length,
    0,
    "no resolve event should be emitted when the open-row update did not match",
  );
});

test("merge moves an open source incident into an open target incident", async () => {
  const mergedAt = new Date(4_000);
  const { db, calls } = recordingDb();

  await mergeIncidentsInTx(db as unknown as Parameters<typeof mergeIncidentsInTx>[0], {
    sourceIncident: makeIncident("open", {
      id: "inc-source",
      issueCount: 2,
      lastSeen: new Date(5_000),
    }),
    targetIncident: makeIncident("open", {
      id: "inc-target",
      issueCount: 3,
      lastSeen: new Date(2_000),
    }),
    mergedAt,
  });

  const updates = incidentUpdates(calls);
  assert.equal(updates.length, 2, "source and target incidents should both be updated");
  assert.equal(updates[0]?.status, "merged");
  assert.equal(updates[0]?.mergedIntoId, "inc-target");
  assert.equal(updates[0]?.mergedAt, mergedAt);
  assert.equal((updates[1]?.lastSeen as Date).getTime(), 5_000);
});

test("merge rejects closed source or target incidents before writing", async () => {
  await assert.rejects(
    () =>
      mergeIncidentsInTx({} as Parameters<typeof mergeIncidentsInTx>[0], {
        sourceIncident: makeIncident("resolved"),
        targetIncident: makeIncident("open"),
      }),
    /mergeIncidentsInTx: cannot transition incident from "resolved"/,
  );
  await assert.rejects(
    () =>
      mergeIncidentsInTx({} as Parameters<typeof mergeIncidentsInTx>[0], {
        sourceIncident: makeIncident("open"),
        targetIncident: makeIncident("autoresolved_noise"),
      }),
    /mergeIncidentsInTx: cannot transition incident from "autoresolved_noise"/,
  );
});

test("manual reopen clears both resolution and noise metadata", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createIncidentLifecycle(db);

  const result = await lifecycle.reopenManually({
    incident: makeIncident("autoresolved_noise"),
    actor: { userId: "user-1" },
    summary: "Incident reopened from test.",
  });

  assert.deepEqual(result, { reopened: true });
  const update = lastIncidentUpdate(calls);
  assert.equal(update.status, "open");
  assert.equal(update.resolvedAt, null);
  assert.equal(update.noiseReason, null);
  assert.equal(update.noiseResolvedAt, null);
  const event = eventInsert(calls);
  assert.equal(event.kind, "incident_reopened");
  assert.equal((event.detail as Record<string, unknown>).reopenedByUserId, "user-1");
});

test("manual reopen is a no-op for already-open incidents", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createIncidentLifecycle(db);

  const result = await lifecycle.reopenManually({
    incident: makeIncident("open"),
    actor: { userId: "user-1" },
  });

  assert.deepEqual(result, { reopened: false });
  assert.equal(calls.length, 0);
});

function makeIncident(
  status: schema.IncidentStatus,
  opts: { id?: string; issueCount?: number; lastSeen?: Date } = {},
): schema.Incident {
  return {
    id: opts.id ?? "inc-1",
    projectId: "proj-1",
    title: "Original title",
    codename: "steady-signal",
    status,
    firstSeen: new Date(0),
    lastSeen: opts.lastSeen ?? new Date(0),
    issueCount: opts.issueCount ?? 1,
    resolvedAt: status === "resolved" ? new Date(0) : null,
    resolvedByKind: status === "resolved" ? "agent_classification" : null,
  } as unknown as schema.Incident;
}

function makeIssue(): schema.Issue {
  return {
    id: "issue-1",
    title: "Issue came back",
    lastSeen: new Date(1_000),
  } as unknown as schema.Issue;
}
