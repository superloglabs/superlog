import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentRunResult, type DB, schema } from "@superlog/db";
import {
  ACTIVE_STATES,
  type AgentRunState,
  DORMANT_STATES,
  type LifecycleEventKind,
  TERMINAL_STATES,
  createAgentRunLifecycle,
  isActiveState,
} from "./agent-run.js";

// ─── State enum sanity ──────────────────────────────────────────────────

test("ACTIVE_STATES + DORMANT_STATES + TERMINAL_STATES partition the AgentRunState enum", () => {
  // Every state value must appear in exactly one of the two sets. Catches
  // accidental drops/dupes when editing the enum.
  const all: AgentRunState[] = [...ACTIVE_STATES, ...DORMANT_STATES, ...TERMINAL_STATES];
  const expected: AgentRunState[] = [
    "queued",
    "repo_discovery",
    "running",
    "awaiting_human",
    "pr_retry_queued",
    "blocked_no_github",
    "complete",
    "failed",
  ];
  assert.deepEqual([...all].sort(), [...expected].sort());
  assert.equal(new Set(all).size, all.length, "no state appears in both sets");
});

test("isActiveState recognises only the active states", () => {
  for (const s of ACTIVE_STATES) assert.equal(isActiveState(s), true, s);
  for (const s of DORMANT_STATES) assert.equal(isActiveState(s), false, s);
  for (const s of TERMINAL_STATES) assert.equal(isActiveState(s), false, s);
});

test("isActiveState returns false for unknown state strings", () => {
  // Defensive: a stray value from the database (e.g. a state string from a
  // future schema version) should not be treated as active.
  assert.equal(isActiveState("unknown_state"), false);
  assert.equal(isActiveState("ready_to_pr"), false); // dropped per ADR reconciliation
});

function lastUpdateValues(calls: RecordedCall[], table: unknown): Record<string, unknown> {
  const updates = calls.filter(
    (c): c is Extract<RecordedCall, { op: "update.where" }> =>
      c.op === "update.where" && c.table === table,
  );
  assert.ok(updates.length > 0, "expected at least one update on this table");
  const latest = updates.at(-1);
  assert.ok(latest);
  return latest.values;
}

function eventInsertValues(calls: RecordedCall[]): Record<string, unknown> {
  const events = calls.filter(
    (c): c is Extract<RecordedCall, { op: "insert.onConflictDoNothing" }> =>
      c.op === "insert.onConflictDoNothing" && c.table === schema.incidentEvents,
  );
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event);
  return event.values;
}

// ─── Recording fake DB ──────────────────────────────────────────────────
//
// The lifecycle module uses a narrow slice of the Drizzle client. This fake
// records each call so tests can assert on it, and provides return values
// where the module reads them (only `insert(...).returning()` does).

type RecordedCall =
  | { op: "insert.returning"; table: unknown; values: Record<string, unknown> }
  | { op: "insert.onConflictDoNothing"; table: unknown; values: Record<string, unknown> }
  | { op: "update.where"; table: unknown; values: Record<string, unknown> }
  | { op: "transaction.begin" }
  | { op: "transaction.end" };

function recordingDb(opts: { insertReturningRow?: Record<string, unknown> } = {}): {
  db: DB;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const insertChain = (table: unknown) => ({
    values(values: Record<string, unknown>) {
      return {
        async returning() {
          calls.push({ op: "insert.returning", table, values });
          return [opts.insertReturningRow ?? { id: "fake-id", ...values }];
        },
        async onConflictDoNothing() {
          calls.push({ op: "insert.onConflictDoNothing", table, values });
        },
      };
    },
  });
  const updateChain = (table: unknown) => ({
    set(values: Record<string, unknown>) {
      return {
        async where(_cond: unknown) {
          calls.push({ op: "update.where", table, values });
        },
      };
    },
  });
  const db = {
    insert: insertChain,
    update: updateChain,
    async transaction(fn: (tx: unknown) => Promise<void>) {
      calls.push({ op: "transaction.begin" });
      await fn(db);
      calls.push({ op: "transaction.end" });
    },
  } as unknown as DB;
  return { db, calls };
}

function failOnAnyDbAccess(): DB {
  // Any access on this DB throws — used to assert that the source-state
  // guard fires before the module attempts any write.
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`db.${String(prop)} accessed but illegal transition should have aborted`);
      },
    },
  ) as unknown as DB;
}

// ─── Illegal transition rejection ────────────────────────────────────────

test("beginRepoDiscovery rejects from running and aborts before db write", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () => lifecycle.beginRepoDiscovery({ id: "i1", currentState: "running" }),
    /cannot transition from "running"/,
  );
});

test("startRunning rejects from queued (must go via repo_discovery first)", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () =>
      lifecycle.startRunning({
        id: "i1",
        currentState: "queued",
        providerSessionId: "sess",
        repoCandidateCount: 0,
      }),
    /cannot transition from "queued"/,
  );
});

test("pauseForHuman rejects from awaiting_human (already paused)", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () =>
      lifecycle.pauseForHuman({
        id: "i1",
        currentState: "awaiting_human",
        summary: "s",
        question: "q",
      }),
    /cannot transition from "awaiting_human"/,
  );
});

test("requeueAfterHumanReply rejects from running", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () => lifecycle.requeueAfterHumanReply({ id: "i1", currentState: "running" }),
    /cannot transition from "running"/,
  );
});

test("resumeRunning rejects from queued", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () =>
      lifecycle.resumeRunning({
        id: "i1",
        currentState: "queued",
        currentResumeCount: 0,
      }),
    /cannot transition from "queued"/,
  );
});

test("startPrRetry rejects from failed until the API queues the retry first", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () => lifecycle.startPrRetry({ id: "i1", currentState: "failed" }),
    /cannot transition from "failed"/,
  );
});

test("completeWithPullRequest rejects from awaiting_human", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () =>
      lifecycle.completeWithPullRequest({
        id: "i1",
        currentState: "awaiting_human",
        result: makeResult("complete"),
        selectedRepoFullName: "org/repo",
        selectedBaseBranch: "main",
        prUrl: "https://example.test/pr/1",
      }),
    /cannot transition from "awaiting_human"/,
  );
});

test("completeWithoutPullRequest rejects from queued", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  await assert.rejects(
    () =>
      lifecycle.completeWithoutPullRequest({
        id: "i1",
        currentState: "queued",
        result: makeResult("complete"),
      }),
    /cannot transition from "queued"/,
  );
});

test("fail rejects from terminal states", async () => {
  const lifecycle = createAgentRunLifecycle(failOnAnyDbAccess());
  for (const s of TERMINAL_STATES) {
    await assert.rejects(
      () =>
        lifecycle.fail({
          id: "i1",
          currentState: s,
          reason: "agent_no_findings",
          summary: "s",
          category: "agent",
        }),
      new RegExp(`cannot transition from "${s}"`),
    );
  }
});

// ─── Legal transition acceptance — every transition emits exactly one event ──

test("enqueue inserts the row and emits exactly one agent_run_queued event", async () => {
  const { db, calls } = recordingDb({
    insertReturningRow: { id: "inv-1", incidentId: "inc-1", state: "queued" },
  });
  const lifecycle = createAgentRunLifecycle(db);

  const row = await lifecycle.enqueue({ incidentId: "inc-1", runtime: "anthropic" });

  assert.equal(row?.id, "inv-1");
  const inserts = calls.filter(
    (c) => c.op === "insert.returning" || c.op === "insert.onConflictDoNothing",
  );
  assert.equal(inserts.length, 2, "one INSERT for agent_runs, one for the event");
  assertEventInsertedOnce(calls, "agent_run_queued");
});

test("startRunning sets state and emits exactly one agent_run_started event", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.startRunning({
    id: "inv-1",
    currentState: "repo_discovery",
    providerSessionId: "sess-abc",
    providerSessionStatus: "running",
    repoCandidateCount: 3,
  });

  const values = lastUpdateValues(calls, schema.agentRuns);
  assert.equal(values.state, "running");
  assertEventInsertedOnce(calls, "agent_run_started");
});

test("pauseForHuman writes the awaiting_human result and emits one event", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.pauseForHuman({
    id: "inv-1",
    currentState: "running",
    summary: "stuck",
    question: "what repo?",
  });

  const result = lastUpdateValues(calls, schema.agentRuns).result as AgentRunResult;
  assert.equal(result.state, "awaiting_human");
  assert.equal(result.summary, "stuck");
  assertEventInsertedOnce(calls, "awaiting_human");
});

test("resumeRunning increments resumeCount and emits a resumed event", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.resumeRunning({
    id: "inv-1",
    currentState: "awaiting_human",
    currentResumeCount: 1,
  });

  const values = lastUpdateValues(calls, schema.agentRuns);
  assert.equal(values.state, "running");
  assert.equal(values.resumeCount, 2);
  assertEventInsertedOnce(calls, "resumed");
});

test("startPrRetry re-enters running and clears the previous failure stamp", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.startPrRetry({
    id: "inv-1",
    currentState: "pr_retry_queued",
  });

  const values = lastUpdateValues(calls, schema.agentRuns);
  assert.equal(values.state, "running");
  assert.equal(values.failureReason, null);
  assert.equal(values.completedAt, null);
});

test("completeWithoutPullRequest emits agent_run_completed (fills the audit gap)", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.completeWithoutPullRequest({
    id: "inv-1",
    currentState: "running",
    result: makeResult("complete"),
  });

  assertEventInsertedOnce(calls, "agent_run_completed");
});

test("completeWithPullRequest writes selected repo + emits pr_opened", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.completeWithPullRequest({
    id: "inv-1",
    currentState: "running",
    result: makeResult("complete"),
    selectedRepoFullName: "org/repo",
    selectedBaseBranch: "main",
    prUrl: "https://example.test/pr/42",
  });

  const values = lastUpdateValues(calls, schema.agentRuns);
  assert.equal(values.selectedRepoFullName, "org/repo");
  assertEventInsertedOnce(calls, "pr_opened");
});

test("completeViaMerge runs a transaction touching all four tables and emits one event", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.completeViaMerge({
    id: "inv-1",
    currentState: "running",
    result: makeResult("complete"),
    sourceIncident: makeIncident("inc-source", { issueCount: 2, lastSeen: new Date(2_000) }),
    targetIncident: makeIncident("inc-target", { issueCount: 5, lastSeen: new Date(1_000) }),
    evidence: "shared frame foo()",
  });

  // Transaction wraps the four table writes; the event emit happens after.
  const beginIdx = calls.findIndex((c) => c.op === "transaction.begin");
  const endIdx = calls.findIndex((c) => c.op === "transaction.end");
  assert.ok(beginIdx >= 0 && endIdx > beginIdx);
  const inTx = calls.slice(beginIdx + 1, endIdx);
  const tablesTouched = inTx
    .filter((c) => c.op === "update.where")
    .map((c) => (c as { table: unknown }).table);
  assert.deepEqual(
    new Set(tablesTouched),
    new Set([schema.agentRuns, schema.incidentIssues, schema.incidents]),
  );
  // Two updates on schema.incidents (source mark + target counter bump) plus
  // one each on the other two tables = 4 writes.
  assert.equal(
    inTx.filter((c) => c.op === "update.where").length,
    4,
    "merge tx writes all four planned updates",
  );
  // The merged_into_incident event happens after the tx, not inside it.
  const event = eventInsertValues(calls);
  assert.equal(event.kind, "merged_into_incident");
});

test("appendContextChangeEvent leaves incident_context_changed unprocessed for runner steering", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.appendContextChangeEvent({
    agentRunId: "inv-1",
    summary: "New issue joined this incident.",
    dedupeKey: "context:issue-1",
  });

  const event = eventInsertValues(calls);
  assert.equal(event.kind, "incident_context_changed");
  assert.equal(event.agentRunId, "inv-1");
  assert.equal(event.summary, "New issue joined this incident.");
  assert.equal(event.processedAt, null);
});

test("fail records failureReason in both the row and the result, emits one event", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  await lifecycle.fail({
    id: "inv-1",
    currentState: "running",
    reason: "patch_validation_failed",
    summary: "validation failed",
    category: "deliverable",
  });

  const v = lastUpdateValues(calls, schema.agentRuns);
  assert.equal(v.state, "failed");
  assert.equal(v.failureReason, "patch_validation_failed");
  assert.equal((v.result as AgentRunResult).failureReason, "patch_validation_failed");
  assertEventInsertedOnce(calls, "terminal_failure");
});

test("fail preserves PR + Linear ticket from existingResult", async () => {
  const { db, calls } = recordingDb();
  const lifecycle = createAgentRunLifecycle(db);

  const existing: AgentRunResult = {
    state: "complete",
    summary: "had a result",
    pr: { selectedRepoFullName: "org/repo", baseBranch: "main" } as schema.AgentRunPr,
    linearTicket: {
      id: "TICKET-1",
      url: null,
      createdByAgent: true,
    } as schema.AgentRunLinearTicket,
  };
  await lifecycle.fail({
    id: "inv-1",
    currentState: "running",
    reason: "pr_open_failed",
    summary: "github 500'd",
    category: "deliverable",
    existingResult: existing,
  });

  const result = lastUpdateValues(calls, schema.agentRuns).result as AgentRunResult;
  assert.equal(result.pr?.selectedRepoFullName, "org/repo");
  assert.equal(result.linearTicket?.id, "TICKET-1");
});

// ─── Helpers ────────────────────────────────────────────────────────────

function assertEventInsertedOnce(calls: RecordedCall[], kind: LifecycleEventKind): void {
  const eventInserts = calls.filter(
    (c): c is Extract<RecordedCall, { op: "insert.onConflictDoNothing" }> =>
      c.op === "insert.onConflictDoNothing" && c.table === schema.incidentEvents,
  );
  const matching = eventInserts.filter((c) => c.values.kind === kind);
  assert.equal(
    matching.length,
    1,
    `expected exactly one ${kind} event, got ${matching.length} (and ${eventInserts.length} events total)`,
  );
}

function makeResult(state: "complete" | "awaiting_human" | "failed"): AgentRunResult {
  return { state, summary: "test summary" } as AgentRunResult;
}

function makeIncident(id: string, opts: { issueCount: number; lastSeen: Date }): schema.Incident {
  return {
    id,
    issueCount: opts.issueCount,
    lastSeen: opts.lastSeen,
    title: `Incident ${id}`,
    codename: null,
    status: "open",
  } as unknown as schema.Incident;
}
