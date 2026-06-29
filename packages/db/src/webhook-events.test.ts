import assert from "node:assert/strict";
import { test } from "node:test";
import type { DB } from "./client.js";
import type * as schema from "./schema.js";
import {
  buildIncidentCreatedPayload,
  buildIncidentUpdatedPayload,
  enqueueWebhookEvent,
  serializeAgentRun,
  serializeIncident,
} from "./webhook-events.js";

function fakeProject(): schema.Project {
  return { id: "proj-1", name: "Default", slug: "default" } as unknown as schema.Project;
}

function fakeIncident(overrides: Partial<schema.Incident> = {}): schema.Incident {
  return {
    id: "inc-1",
    projectId: "proj-1",
    title: "TypeError in /api/orders",
    codename: "squishy-narwhal",
    status: "open",
    severity: "SEV-2",
    suggestedSeverity: "SEV-2",
    service: "orders",
    environment: "production",
    firstSeen: new Date("2026-05-11T11:00:00.000Z"),
    lastSeen: new Date("2026-05-11T12:30:00.000Z"),
    issueCount: 14,
    agentSummary: null,
    rootCauseText: null,
    rootCauseConfidence: null,
    estimatedImpactText: null,
    estimatedImpactConfidence: null,
    noiseClassification: null,
    resolutionClassification: null,
    findingsAgentRunId: null,
    resolvedAt: null,
    resolvedByKind: null,
    resolvedReasonCode: null,
    resolvedReasonText: null,
    mergedIntoId: null,
    mergedAt: null,
    ...overrides,
  } as unknown as schema.Incident;
}

function fakeAgentRun(overrides: Partial<schema.AgentRun> = {}): schema.AgentRun {
  return {
    id: "run-1",
    incidentId: "inc-1",
    runtime: "anthropic",
    state: "running",
    trigger: "incident",
    startedAt: new Date("2026-05-11T12:20:00.000Z"),
    completedAt: null,
    cumulativeRuntimeMinutes: 3,
    resumeCount: 0,
    failureReason: null,
    selectedRepoFullName: null,
    selectedBaseBranch: null,
    result: null,
    ...overrides,
  } as unknown as schema.AgentRun;
}

test("serializeIncident omits operational columns and flattens findings", () => {
  const out = serializeIncident(
    fakeIncident({ rootCauseText: "null deref", rootCauseConfidence: 9 }),
  );
  assert.equal(out.id, "inc-1");
  assert.equal(out.codename, "squishy-narwhal");
  assert.equal(out.status, "open");
  assert.equal(out.rootCauseText, "null deref");
  assert.equal(out.rootCauseConfidence, 9);
  assert.equal(out.firstSeen, "2026-05-11T11:00:00.000Z");
  // Slack/billing internals must not leak.
  assert.equal("slackChannelId" in out, false);
  assert.equal("autoInvestigateSuppressedUntil" in out, false);
});

test("serializeAgentRun derives failureCategory from failureReason", () => {
  const out = serializeAgentRun(
    fakeAgentRun({ state: "failed", failureReason: "agent_no_result" }),
  );
  assert.equal(out.state, "failed");
  assert.equal(out.failureReason, "agent_no_result");
  assert.equal(typeof out.failureCategory, "string");
});

test("serializeAgentRun leaves failureCategory null when no failure", () => {
  assert.equal(serializeAgentRun(fakeAgentRun()).failureCategory, null);
});

// --- incident.created ------------------------------------------------------

test("buildIncidentCreatedPayload carries a render-ready message", () => {
  const p = buildIncidentCreatedPayload(fakeIncident(), fakeProject());
  assert.equal(p.event, "incident.created");
  assert.equal(typeof p.eventId, "string");
  assert.equal(typeof p.occurredAt, "string");
  assert.deepEqual(p.project, { id: "proj-1", name: "Default", slug: "default" });
  assert.equal(p.incident.id, "inc-1");
  assert.equal(p.message.title, "TypeError in /api/orders");
  assert.equal(p.message.body, "New incident (SEV-2 · orders · production).");
});

// --- incident.updated change discriminators --------------------------------

test("incident.updated resolved surfaces the resolution audit + message", () => {
  const p = buildIncidentUpdatedPayload(
    fakeIncident({
      status: "resolved",
      resolvedAt: new Date("2026-05-11T13:00:00.000Z"),
      resolvedByKind: "slack_manual",
      resolvedReasonCode: "manual",
      resolvedReasonText: "looks fine now",
    }),
    fakeProject(),
    { kind: "resolved" },
  );
  assert.equal(p.event, "incident.updated");
  assert.equal(p.change.kind, "resolved");
  assert.deepEqual(p.change.resolution, {
    kind: "slack_manual",
    reasonCode: "manual",
    reasonText: "looks fine now",
    resolvedAt: "2026-05-11T13:00:00.000Z",
    status: "resolved",
  });
  assert.equal(p.message.body, "Resolved: looks fine now");
});

test("incident.updated resolved renders the noise auto-close path", () => {
  const p = buildIncidentUpdatedPayload(
    fakeIncident({ status: "autoresolved_noise" }),
    fakeProject(),
    { kind: "resolved" },
  );
  assert.equal((p.change.resolution as { status: string }).status, "autoresolved_noise");
  assert.equal(p.message.body, "Auto-closed as noise.");
});

test("incident.updated resolved fills the resolution block from noise columns", () => {
  // The noise auto-close path stamps noiseResolvedAt / noiseReason instead of
  // the resolved* columns; the payload must fall back to those rather than
  // emitting an all-null resolution block.
  const p = buildIncidentUpdatedPayload(
    fakeIncident({
      status: "autoresolved_noise",
      noiseResolvedAt: new Date("2026-05-11T13:05:00.000Z"),
      noiseReason: "cosmetic_log_only",
    }),
    fakeProject(),
    { kind: "resolved" },
  );
  assert.deepEqual(p.change.resolution, {
    kind: "autoresolved_noise",
    reasonCode: "cosmetic_log_only",
    reasonText: null,
    resolvedAt: "2026-05-11T13:05:00.000Z",
    status: "autoresolved_noise",
  });
});

test("incident.updated resolved without a reason renders a bare message", () => {
  const p = buildIncidentUpdatedPayload(
    fakeIncident({ status: "resolved", resolvedAt: new Date("2026-05-11T13:00:00.000Z") }),
    fakeProject(),
    { kind: "resolved" },
  );
  assert.equal(p.message.body, "Resolved.");
});

test("incident.updated agent_completed without a PR omits the PR clause", () => {
  const run = fakeAgentRun({
    state: "complete",
    completedAt: new Date("2026-05-11T12:34:00.000Z"),
    result: { summary: "no code change needed" } as unknown as schema.AgentRun["result"],
  });
  const p = buildIncidentUpdatedPayload(
    fakeIncident(),
    fakeProject(),
    { kind: "agent_completed" },
    { agentRun: serializeAgentRun(run), events: [], pullRequests: [], linearTickets: [] },
  );
  assert.equal(p.message.body, "Investigation complete: no code change needed");
});

test("incident.updated reopened carries the reason + message", () => {
  const p = buildIncidentUpdatedPayload(fakeIncident(), fakeProject(), {
    kind: "reopened",
    reason: "issue_regressed",
    previousStatus: "resolved",
  });
  assert.equal(p.change.kind, "reopened");
  assert.equal(p.change.reason, "issue_regressed");
  assert.equal(p.change.previousStatus, "resolved");
  assert.equal(p.message.body, "Reopened — the underlying issue regressed.");
});

test("incident.updated merged includes the survivor + evidence", () => {
  const p = buildIncidentUpdatedPayload(fakeIncident(), fakeProject(), {
    kind: "merged",
    mergedInto: { id: "inc-2", codename: "brave-otter", title: "Other", status: "open" },
    evidence: "same stack frame",
  });
  assert.equal(p.change.kind, "merged");
  assert.deepEqual(p.change.mergedInto, {
    id: "inc-2",
    codename: "brave-otter",
    title: "Other",
    status: "open",
  });
  assert.equal(p.change.evidence, "same stack frame");
  assert.equal(p.message.body, "Merged into brave-otter — Other.");
});

test("incident.updated agent_started nests the agent run", () => {
  const p = buildIncidentUpdatedPayload(
    fakeIncident(),
    fakeProject(),
    { kind: "agent_started" },
    { agentRun: serializeAgentRun(fakeAgentRun()) },
  );
  assert.equal(p.change.kind, "agent_started");
  assert.equal(p.agentRun?.id, "run-1");
  assert.equal(p.message.body, "Investigation started.");
});

test("incident.updated agent_completed renders summary + PR from the result", () => {
  const run = fakeAgentRun({
    state: "complete",
    completedAt: new Date("2026-05-11T12:34:00.000Z"),
    result: {
      summary: "missing null check in orders.ts",
      pr: { url: "https://github.com/acme/orders/pull/42" },
    } as unknown as schema.AgentRun["result"],
  });
  const p = buildIncidentUpdatedPayload(
    fakeIncident(),
    fakeProject(),
    { kind: "agent_completed" },
    {
      agentRun: serializeAgentRun(run),
      events: [],
      pullRequests: [],
      linearTickets: [],
    },
  );
  assert.equal(p.change.kind, "agent_completed");
  assert.equal(
    p.message.body,
    "Investigation complete: missing null check in orders.ts Opened PR: https://github.com/acme/orders/pull/42",
  );
  assert.deepEqual(p.events, []);
  assert.deepEqual(p.pullRequests, []);
});

test("incident.updated agent_failed exposes the failure metadata + message", () => {
  const p = buildIncidentUpdatedPayload(
    fakeIncident(),
    fakeProject(),
    { kind: "agent_failed" },
    {
      agentRun: serializeAgentRun(
        fakeAgentRun({ state: "failed", failureReason: "agent_no_result" }),
      ),
    },
  );
  assert.equal(p.change.kind, "agent_failed");
  assert.equal(p.agentRun?.failureReason, "agent_no_result");
  assert.equal(p.message.body, "Investigation failed: agent_no_result");
});

test("incident.updated agent_awaiting_input carries the prompt", () => {
  const p = buildIncidentUpdatedPayload(
    fakeIncident(),
    fakeProject(),
    {
      kind: "agent_awaiting_input",
      reason: "repository_selection",
      summary: "Which repo?",
      question: "orders or web?",
    },
    { agentRun: serializeAgentRun(fakeAgentRun({ state: "awaiting_human" })) },
  );
  assert.equal(p.change.kind, "agent_awaiting_input");
  assert.equal(p.change.reason, "repository_selection");
  assert.equal(p.change.question, "orders or web?");
  assert.equal(p.message.body, "Which repo? orders or web?");
});

// --- enqueueWebhookEvent fan-out -------------------------------------------

type InsertedRow = { endpointId: string; eventType: string; payload: unknown };

function fakeEnqueueDb(endpoints: Array<Partial<schema.WebhookEndpoint>>): {
  db: DB;
  inserted: InsertedRow[];
} {
  const inserted: InsertedRow[] = [];
  const db = {
    query: {
      webhookEndpoints: {
        async findMany() {
          return endpoints;
        },
      },
    },
    insert() {
      return {
        async values(rows: InsertedRow[]) {
          inserted.push(...rows);
        },
      };
    },
  } as unknown as DB;
  return { db, inserted };
}

test("enqueueWebhookEvent only fans out to endpoints subscribed to the event", async () => {
  const { db, inserted } = fakeEnqueueDb([
    { id: "ep-1", enabledEvents: ["incident.created", "incident.updated"] },
    { id: "ep-2", enabledEvents: ["incident.updated"] },
    { id: "ep-3", enabledEvents: ["incident.created"] },
  ]);
  const count = await enqueueWebhookEvent({
    database: db,
    projectId: "proj-1",
    eventType: "incident.created",
    payload: { event: "incident.created" },
  });
  assert.equal(count, 2);
  assert.deepEqual(inserted.map((r) => r.endpointId).sort(), ["ep-1", "ep-3"]);
  assert.ok(inserted.every((r) => r.eventType === "incident.created"));
});

test("enqueueWebhookEvent is a no-op when nobody subscribes", async () => {
  const { db, inserted } = fakeEnqueueDb([{ id: "ep-1", enabledEvents: ["incident.created"] }]);
  const count = await enqueueWebhookEvent({
    database: db,
    projectId: "proj-1",
    eventType: "incident.updated",
    payload: {},
  });
  assert.equal(count, 0);
  assert.equal(inserted.length, 0);
});
