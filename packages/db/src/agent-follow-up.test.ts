import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  FOLLOW_UP_MAX_AGE_DAYS,
  MAX_FOLLOW_UP_RUNS,
  decideInboundContinuation,
  evaluateFollowUpEligibility,
  recordInboundInteraction,
  requestFollowUpAgentRun,
  requestOpenPrAgentRun,
  restartAgentRun,
  retryBlockedAgentRun,
} from "./agent-follow-up.js";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const RECENT = new Date("2026-06-09T12:00:00Z");
const STALE = new Date(NOW.getTime() - (FOLLOW_UP_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000);
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected a row");
  return row;
}

async function freshFollowUpDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

async function seedFollowUpIncident(db: DB) {
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: "Acme", slug: `acme-${crypto.randomUUID()}` })
    .returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Project", slug: `project-${crypto.randomUUID()}` })
    .returning();
  assert.ok(project);
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      title: "Follow-up concurrency",
      codename: `follow-up-${crypto.randomUUID()}`,
      status: "open",
      firstSeen: RECENT,
      lastSeen: RECENT,
    })
    .returning();
  assert.ok(incident);
  const [priorRun] = await db
    .insert(schema.agentRuns)
    .values({
      incidentId: incident.id,
      runtime: "test",
      state: "complete",
      trigger: "incident",
      completedAt: RECENT,
    })
    .returning();
  assert.ok(priorRun);
  return { incident, priorRun };
}

function input(overrides: Partial<Parameters<typeof evaluateFollowUpEligibility>[0]> = {}) {
  return {
    agentRunEnabled: true,
    autoFollowUpEnabled: true,
    confirmed: false,
    priorRun: { state: "complete", completedAt: RECENT },
    followUpCount: 0,
    activeRun: null,
    now: NOW,
    ...overrides,
  };
}

test("eligible interaction on a recently completed run enqueues", () => {
  assert.deepEqual(evaluateFollowUpEligibility(input()), { action: "enqueue" });
});

test("failed prior runs are also revivable", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ priorRun: { state: "failed", completedAt: RECENT } }),
  );
  assert.deepEqual(verdict, { action: "enqueue" });
});

test("skips when agent runs are disabled for the project", () => {
  const verdict = evaluateFollowUpEligibility(input({ agentRunEnabled: false }));
  assert.deepEqual(verdict, { action: "skip", reason: "agent_runs_disabled" });
});

test("skips when auto follow-up is disabled and the request is not confirmed", () => {
  const verdict = evaluateFollowUpEligibility(input({ autoFollowUpEnabled: false }));
  assert.deepEqual(verdict, { action: "skip", reason: "auto_follow_up_disabled" });
});

test("a confirmed request bypasses the auto-follow-up gate but not the rest", () => {
  assert.deepEqual(
    evaluateFollowUpEligibility(input({ autoFollowUpEnabled: false, confirmed: true })),
    { action: "enqueue" },
  );
  assert.deepEqual(
    evaluateFollowUpEligibility(
      input({ autoFollowUpEnabled: false, confirmed: true, followUpCount: MAX_FOLLOW_UP_RUNS }),
    ),
    { action: "skip", reason: "follow_up_cap_reached" },
  );
});

test("skips when there is no terminal prior run", () => {
  assert.deepEqual(evaluateFollowUpEligibility(input({ priorRun: null })), {
    action: "skip",
    reason: "no_prior_run",
  });
  assert.deepEqual(
    evaluateFollowUpEligibility(input({ priorRun: { state: "running", completedAt: null } })),
    { action: "skip", reason: "no_prior_run" },
  );
});

test("skips interactions older than the staleness window", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ priorRun: { state: "complete", completedAt: STALE } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "prior_run_too_old" });
});

test("skips once the per-incident follow-up cap is reached", () => {
  const verdict = evaluateFollowUpEligibility(input({ followUpCount: MAX_FOLLOW_UP_RUNS }));
  assert.deepEqual(verdict, { action: "skip", reason: "follow_up_cap_reached" });
});

test("append wins over the cap so review-burst interactions are not dropped", () => {
  const verdict = evaluateFollowUpEligibility(
    input({
      followUpCount: MAX_FOLLOW_UP_RUNS,
      activeRun: { id: "run-2", state: "queued", trigger: "pr_comment" },
    }),
  );
  assert.deepEqual(verdict, { action: "append", runId: "run-2" });
});

test("appends to a still-queued follow-up run instead of enqueuing a second", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-2", state: "queued", trigger: "pr_comment" } }),
  );
  assert.deepEqual(verdict, { action: "append", runId: "run-2" });
});

test("skips while a run is actively executing", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-2", state: "running", trigger: "pr_comment" } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "run_active" });
});

test("skips when the active run is the original (non-follow-up) investigation", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-1", state: "queued", trigger: "incident" } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "run_active" });
});

test("treats a queued manual investigation as initial — skips, does not append", () => {
  // A user-started ("manual") run is an initial investigation like "incident":
  // an inbound interaction while it's queued must not stack onto it.
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-1", state: "queued", trigger: "manual" } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "run_active" });
});

// --- Session-continuity routing (decideInboundContinuation) ---
//
// The new model: an inbound message continues the SAME durable provider
// session rather than spinning up a fresh investigation. These tests pin the
// routing decision; the worker handles the actual resume/steer/fall-back.

function continuation(overrides: Partial<Parameters<typeof decideInboundContinuation>[0]> = {}) {
  return {
    agentRunEnabled: true,
    autoFollowUpEnabled: true,
    confirmed: false,
    latestRun: { id: "run-1", state: "complete", providerSessionId: "sess_1" },
    ...overrides,
  };
}

test("a completed run with a live session resumes that session (no new investigation)", () => {
  assert.deepEqual(decideInboundContinuation(continuation()), {
    action: "resume",
    runId: "run-1",
  });
});

test("a failed run with a session is still resumable", () => {
  assert.deepEqual(
    decideInboundContinuation(
      continuation({ latestRun: { id: "run-2", state: "failed", providerSessionId: "sess_2" } }),
    ),
    { action: "resume", runId: "run-2" },
  );
});

test("a terminal run without a session falls back to a cold-start run", () => {
  assert.deepEqual(
    decideInboundContinuation(
      continuation({ latestRun: { id: "run-3", state: "complete", providerSessionId: null } }),
    ),
    { action: "cold_start" },
  );
});

test("a message arriving mid-turn steers the running session instead of stacking a run", () => {
  for (const state of ["running", "repo_discovery"]) {
    assert.deepEqual(
      decideInboundContinuation(
        continuation({ latestRun: { id: "run-4", state, providerSessionId: "sess_4" } }),
      ),
      { action: "steer", runId: "run-4" },
      `state=${state}`,
    );
  }
});

test("an awaiting-human run always delivers (worker resumes, or requeues if no session yet)", () => {
  assert.deepEqual(
    decideInboundContinuation(
      continuation({ latestRun: { id: "run-5", state: "awaiting_human", providerSessionId: "s" } }),
    ),
    { action: "resume", runId: "run-5" },
  );
  assert.deepEqual(
    decideInboundContinuation(
      continuation({
        latestRun: { id: "run-5", state: "awaiting_human", providerSessionId: null },
      }),
    ),
    { action: "resume", runId: "run-5" },
  );
});

test("no prior run at all has nothing to continue", () => {
  assert.deepEqual(decideInboundContinuation(continuation({ latestRun: null })), {
    action: "skip",
    reason: "no_prior_run",
  });
});

test("project gates still apply: agent runs disabled, auto-follow-up off (unless confirmed)", () => {
  assert.deepEqual(decideInboundContinuation(continuation({ agentRunEnabled: false })), {
    action: "skip",
    reason: "agent_runs_disabled",
  });
  assert.deepEqual(decideInboundContinuation(continuation({ autoFollowUpEnabled: false })), {
    action: "skip",
    reason: "auto_follow_up_disabled",
  });
  // An explicit human confirmation (e.g. the feedback button) bypasses the
  // auto-follow-up gate and still resumes.
  assert.deepEqual(
    decideInboundContinuation(continuation({ autoFollowUpEnabled: false, confirmed: true })),
    { action: "resume", runId: "run-1" },
  );
});

type LockedInboundCall =
  | "transaction.begin"
  | "transaction.end"
  | "incident.lock"
  | "dedupe.lookup"
  | "latest_run.lookup"
  | "follow_up_runs.lookup"
  | "open_prs.lookup"
  | "event.insert"
  | "run.update";

function lockedInboundDb(opts: {
  incidentStatus?: schema.IncidentStatus;
  latestRun: {
    id: string;
    state: schema.AgentRun["state"];
    trigger: schema.AgentRunTrigger;
    triggerDetail: schema.AgentRunTriggerDetail | null;
    providerSessionId: string | null;
    completedAt: Date | null;
    runtime: string;
  };
  priorRun?: {
    id: string;
    state: schema.AgentRun["state"];
    trigger: schema.AgentRunTrigger;
    triggerDetail: schema.AgentRunTriggerDetail | null;
    providerSessionId: string | null;
    completedAt: Date | null;
    runtime: string;
  };
  openPullRequests?: schema.AgentRunFollowUpPullRequest[];
  existingDedupeEvent?: { id: string };
}): { db: DB; calls: LockedInboundCall[]; writes: Array<Record<string, unknown>> } {
  const calls: LockedInboundCall[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const incident = {
    id: "incident-1",
    projectId: "project-1",
    status: opts.incidentStatus ?? ("open" as const),
  };
  const automation = {
    agentRunEnabled: true,
    autoFollowUpEnabled: true,
    agentRunProvider: "anthropic",
  };
  const query = {
    incidents: {
      async findFirst() {
        return incident;
      },
    },
    projectAutomationSettings: {
      async findFirst() {
        return automation;
      },
    },
    agentRuns: {
      async findFirst() {
        calls.push("latest_run.lookup");
        return opts.latestRun;
      },
      async findMany() {
        calls.push("follow_up_runs.lookup");
        return [opts.latestRun, ...(opts.priorRun ? [opts.priorRun] : [])];
      },
    },
    incidentEvents: {
      async findFirst() {
        calls.push("dedupe.lookup");
        return opts.existingDedupeEvent;
      },
    },
    agentPullRequests: {
      async findMany() {
        calls.push("open_prs.lookup");
        return (opts.openPullRequests ?? []).map(({ agentPrId, ...pullRequest }) => ({
          id: agentPrId,
          ...pullRequest,
        }));
      },
    },
  };
  const db = {
    query,
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async for() {
                      if (table === schema.agentRuns) {
                        calls.push("latest_run.lookup");
                        return [opts.latestRun];
                      }
                      calls.push("incident.lock");
                      return [incident];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  calls.push("event.insert");
                  writes.push({ table, ...values });
                  return [{ id: "claim-1" }];
                },
              };
            },
            async returning() {
              writes.push({ table, ...values });
              return [{ id: "follow-up-created" }];
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              const pending = Promise.resolve(undefined);
              return Object.assign(pending, {
                async returning() {
                  calls.push("run.update");
                  writes.push({ table, ...values });
                  return [{ id: opts.latestRun.id }];
                },
              });
            },
          };
        },
      };
    },
    delete() {
      return { async where() {} };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      calls.push("transaction.begin");
      const result = await fn(db);
      calls.push("transaction.end");
      return result;
    },
  } as unknown as DB;
  return { db, calls, writes };
}

test("existing-session-only lifecycle delivery appends to the locked queued successor", async () => {
  const lifecycleInteraction = {
    channel: "pr_closed" as const,
    author: null,
    text: "PR #1 was closed.",
    occurredAt: "2026-07-15T08:45:00.000Z",
  };
  const nextLifecycleInteraction = {
    channel: "pr_merged" as const,
    author: null,
    text: "PR #2 was merged.",
    occurredAt: "2026-07-15T08:46:00.000Z",
  };
  const pullRequests = [
    {
      agentPrId: "agent-pr-3",
      repoFullName: "acme/worker",
      prNumber: 3,
      url: "https://github.com/acme/worker/pull/3",
      branchName: "ash/fix-worker",
      baseBranch: "main",
      state: "open" as const,
    },
  ];
  const { db, calls, writes } = lockedInboundDb({
    latestRun: {
      id: "successor-1",
      state: "queued",
      trigger: "pr_closed",
      triggerDetail: { interactions: [lifecycleInteraction], pullRequests },
      providerSessionId: null,
      completedAt: null,
      runtime: "anthropic",
    },
    priorRun: {
      id: "source-1",
      state: "failed",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: "session-1",
      completedAt: new Date("2026-07-15T08:45:30.000Z"),
      runtime: "anthropic",
    },
    openPullRequests: pullRequests,
  });

  const result = await recordInboundInteraction(db, {
    incidentId: "incident-1",
    interaction: nextLifecycleInteraction,
    dedupeKey: "agent_pr_merged:agent-pr-2",
    existingSessionOnly: true,
    now: NOW,
  });

  assert.deepEqual(result, {
    outcome: "accepted",
    action: "cold_start",
    agentRunId: "successor-1",
  });
  assert.ok(calls.indexOf("incident.lock") < calls.indexOf("latest_run.lookup"));
  assert.equal(calls[0], "transaction.begin");
  assert.equal(calls.at(-1), "transaction.end");
  const successorUpdate = writes.find(
    (write) => write.table === schema.agentRuns && "triggerDetail" in write,
  );
  assert.deepEqual(successorUpdate?.triggerDetail, {
    interactions: [lifecycleInteraction, nextLifecycleInteraction],
    pullRequests,
  });
  const claim = writes.find((write) => write.table === schema.incidentEvents);
  assert.equal(claim?.agentRunId, "successor-1");
  assert.deepEqual(claim?.detail, { origin: nextLifecycleInteraction });
  assert.equal(claim?.processedAt, NOW);
});

test("direct follow-up requests serialize on the Incident before appending", async () => {
  const queuedInteraction = {
    channel: "pr_closed" as const,
    author: null,
    text: "PR #2 was closed.",
    occurredAt: "2026-07-15T08:45:00.000Z",
  };
  const reply = {
    channel: "slack_reply" as const,
    author: "alice",
    text: "Please keep working.",
    occurredAt: "2026-07-15T08:46:00.000Z",
  };
  const { db, calls } = lockedInboundDb({
    latestRun: {
      id: "successor-1",
      state: "queued",
      trigger: "pr_closed",
      triggerDetail: { interactions: [queuedInteraction] },
      providerSessionId: null,
      completedAt: null,
      runtime: "anthropic",
    },
  });

  const result = await requestFollowUpAgentRun(db, {
    incidentId: "incident-1",
    trigger: reply.channel,
    interaction: reply,
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "appended", agentRunId: "successor-1" });
  assert.equal(calls[0], "transaction.begin");
  assert.ok(calls.indexOf("incident.lock") < calls.indexOf("latest_run.lookup"));
  assert.equal(calls.at(-1), "transaction.end");
});

test("direct follow-up requests do not enqueue or append after Incident resolution", async () => {
  const { db, writes } = lockedInboundDb({
    incidentStatus: "resolved",
    latestRun: {
      id: "source-1",
      state: "complete",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: null,
      completedAt: RECENT,
      runtime: "anthropic",
    },
  });

  const result = await requestFollowUpAgentRun(db, {
    incidentId: "incident-1",
    trigger: "slack_reply",
    interaction: {
      channel: "slack_reply",
      author: "alice",
      text: "Please investigate again.",
      occurredAt: NOW.toISOString(),
    },
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "skipped", reason: "incident_not_open" });
  assert.deepEqual(writes, []);
});

test("an explicit Open a PR request queues a fresh run with remediation instructions", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    await db.insert(schema.projectAutomationSettings).values({
      projectId: incident.projectId,
      autoFollowUpEnabled: false,
      prPolicy: "never",
    });

    const result = await requestOpenPrAgentRun(db, {
      incidentId: incident.id,
      requestedBy: "U123",
      requestId: "U123:1712345.6789",
      now: NOW,
    });

    assert.equal(result.outcome, "enqueued");
    if (result.outcome !== "enqueued") return;
    const run = await db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, result.agentRunId),
    });
    assert.equal(run?.trigger, "slack_open_pr");
    assert.deepEqual(run?.triggerDetail?.interactions, [
      {
        channel: "slack_open_pr",
        author: "U123",
        text: "Fix the confirmed incident cause and open a pull request with the validated changes.",
        occurredAt: NOW.toISOString(),
      },
    ]);
  } finally {
    await client.close();
  }
});

test("an Open a PR request upgrades an already-queued follow-up to PR capability", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    const queued = await requestFollowUpAgentRun(db, {
      incidentId: incident.id,
      trigger: "slack_reply",
      interaction: {
        channel: "slack_reply",
        author: "U123",
        text: "Please keep investigating.",
        occurredAt: NOW.toISOString(),
      },
      now: NOW,
    });
    assert.equal(queued.outcome, "enqueued");

    const result = await requestOpenPrAgentRun(db, {
      incidentId: incident.id,
      requestedBy: "U456",
      requestId: "U456:1712346.6789",
      now: new Date(NOW.getTime() + 1_000),
    });

    assert.equal(result.outcome, "appended");
    if (result.outcome !== "appended") return;
    const run = await db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, result.agentRunId),
    });
    assert.equal(run?.trigger, "slack_open_pr");
    assert.equal(run?.triggerDetail?.interactions.length, 2);
  } finally {
    await client.close();
  }
});

test("Open a PR requests deduplicate Slack retries before enqueue side effects", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    const args = {
      incidentId: incident.id,
      requestedBy: "U123",
      requestId: "U123:1712345.6789",
      now: NOW,
    };

    const first = await requestOpenPrAgentRun(db, args);
    const retry = await requestOpenPrAgentRun(db, args);

    assert.equal(first.outcome, "enqueued");
    assert.deepEqual(retry, { outcome: "duplicate" });
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(runs.filter((run) => run.trigger === "slack_open_pr").length, 1);
    const openPrRun = runs.find((run) => run.trigger === "slack_open_pr");
    assert.equal(openPrRun?.triggerDetail?.interactions.length, 1);
  } finally {
    await client.close();
  }
});

test("a newly-enqueued follow-up carries every currently-open Incident PR", async () => {
  const openPullRequests: schema.AgentRunFollowUpPullRequest[] = [
    {
      agentPrId: "agent-pr-api",
      repoFullName: "acme/api",
      prNumber: 11,
      url: "https://github.com/acme/api/pull/11",
      branchName: "ash/fix-api",
      baseBranch: "main",
      state: "open",
    },
    {
      agentPrId: "agent-pr-worker",
      repoFullName: "acme/worker",
      prNumber: 12,
      url: "https://github.com/acme/worker/pull/12",
      branchName: "ash/fix-worker",
      baseBranch: "main",
      state: "open",
    },
  ];
  const interaction = {
    channel: "slack_reply" as const,
    author: "alice",
    text: "Please continue with both fixes.",
    occurredAt: NOW.toISOString(),
  };
  const { db, writes } = lockedInboundDb({
    latestRun: {
      id: "source-1",
      state: "complete",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: null,
      completedAt: RECENT,
      runtime: "anthropic",
    },
    openPullRequests,
  });

  const result = await requestFollowUpAgentRun(db, {
    incidentId: "incident-1",
    trigger: interaction.channel,
    interaction,
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "enqueued", agentRunId: "follow-up-created" });
  const successor = writes.find(
    (write) => write.table === schema.agentRuns && write.state === "queued",
  );
  assert.deepEqual(successor?.triggerDetail, {
    interactions: [interaction],
    pullRequests: openPullRequests,
  });
});

test("appending a lifecycle event removes the settled last PR from queued handoff context", async () => {
  for (const channel of ["pr_merged", "pr_closed"] as const) {
    const settledPullRequest: schema.AgentRunFollowUpPullRequest = {
      agentPrId: "agent-pr-1",
      repoFullName: "acme/api",
      prNumber: 1,
      url: "https://github.com/acme/api/pull/1",
      branchName: "ash/fix-api",
      baseBranch: "main",
      state: "open",
    };
    const { db, calls, writes } = lockedInboundDb({
      latestRun: {
        id: "successor-1",
        state: "queued",
        trigger: "pr_merged",
        triggerDetail: {
          interactions: [],
          pullRequests: [settledPullRequest],
        },
        providerSessionId: null,
        completedAt: null,
        runtime: "anthropic",
      },
      // The lifecycle mutation committed before this Incident-locked append;
      // there are no remaining open PRs to hand to the successor.
      openPullRequests: [],
    });
    const interaction = {
      channel,
      author: "octocat",
      text: channel === "pr_merged" ? "PR #1 merged." : "PR #1 closed.",
      occurredAt: NOW.toISOString(),
    };

    const result = await requestFollowUpAgentRun(db, {
      incidentId: "incident-1",
      trigger: channel,
      interaction,
      now: NOW,
    });

    assert.deepEqual(result, { outcome: "appended", agentRunId: "successor-1" });
    assert.ok(calls.includes("open_prs.lookup"));
    const successorUpdate = writes.find(
      (write) => write.table === schema.agentRuns && "triggerDetail" in write,
    );
    assert.deepEqual(successorUpdate?.triggerDetail, {
      interactions: [interaction],
      pullRequests: [],
    });
  }
});

test("concurrent follow-up requests create one successor and preserve every interaction", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const chronological = (items: schema.AgentRunFollowUpInteraction[]) =>
      [...items].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const { incident } = await seedFollowUpIncident(db);
    const interactions = [
      {
        channel: "slack_reply" as const,
        author: "alice",
        text: "First concurrent reply.",
        occurredAt: "2026-06-10T12:01:00.000Z",
      },
      {
        channel: "linear_reply" as const,
        author: "bob",
        text: "Second concurrent reply.",
        occurredAt: "2026-06-10T12:02:00.000Z",
      },
    ];

    const firstResults = await Promise.all(
      interactions.map((interaction) =>
        requestFollowUpAgentRun(db, {
          incidentId: incident.id,
          trigger: interaction.channel,
          interaction,
          now: NOW,
        }),
      ),
    );

    assert.deepEqual(firstResults.map((result) => result.outcome).sort(), ["appended", "enqueued"]);
    let successors = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    let queued = successors.filter((run) => run.trigger !== "incident");
    assert.equal(queued.length, 1);
    assert.deepEqual(
      chronological(queued[0]?.triggerDetail?.interactions ?? []),
      chronological(interactions),
    );

    const appendedInteractions = [
      {
        channel: "slack_reply" as const,
        author: "carol",
        text: "Third concurrent reply.",
        occurredAt: "2026-06-10T12:03:00.000Z",
      },
      {
        channel: "web_chat" as const,
        author: "dave",
        text: "Fourth concurrent reply.",
        occurredAt: "2026-06-10T12:04:00.000Z",
      },
    ];
    const appendResults = await Promise.all(
      appendedInteractions.map((interaction) =>
        requestFollowUpAgentRun(db, {
          incidentId: incident.id,
          trigger: interaction.channel,
          interaction,
          now: NOW,
        }),
      ),
    );

    assert.deepEqual(
      appendResults.map((result) => result.outcome),
      ["appended", "appended"],
    );
    successors = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    queued = successors.filter((run) => run.trigger !== "incident");
    assert.equal(queued.length, 1);
    assert.deepEqual(
      chronological(queued[0]?.triggerDetail?.interactions ?? []),
      chronological([...interactions, ...appendedInteractions]),
    );
  } finally {
    await client.close();
  }
});

test("existing-session-only routing forbids a new run after the Incident lock", async () => {
  const { db, calls, writes } = lockedInboundDb({
    latestRun: {
      id: "successor-1",
      state: "running",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: null,
      completedAt: null,
      runtime: "anthropic",
    },
  });

  const result = await recordInboundInteraction(db, {
    incidentId: "incident-1",
    interaction: {
      channel: "pr_merged",
      author: "alice",
      text: "PR #1 merged.",
      occurredAt: NOW.toISOString(),
    },
    dedupeKey: "agent_pr_merged:pr-1",
    existingSessionOnly: true,
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "skipped", reason: "no_resumable_session" });
  assert.ok(calls.indexOf("incident.lock") < calls.indexOf("latest_run.lookup"));
  assert.deepEqual(writes, []);
});

test("ordinary continuation routing cannot reactivate a resolved Incident", async () => {
  const { db, writes } = lockedInboundDb({
    incidentStatus: "resolved",
    latestRun: {
      id: "run-1",
      state: "complete",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: "session-1",
      completedAt: NOW,
      runtime: "anthropic",
    },
  });

  const result = await recordInboundInteraction(db, {
    incidentId: "incident-1",
    interaction: {
      channel: "slack_reply",
      author: "alice",
      text: "Please investigate again.",
      occurredAt: NOW.toISOString(),
    },
    dedupeKey: "slack:resolved-reply",
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "skipped", reason: "incident_not_open" });
  assert.deepEqual(writes, []);
});

test("a pull request comment is recorded as GitHub input rather than a human reply", async () => {
  const { db, writes } = lockedInboundDb({
    latestRun: {
      id: "run-1",
      state: "running",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: "session-1",
      completedAt: null,
      runtime: "anthropic",
    },
  });

  const result = await recordInboundInteraction(db, {
    incidentId: "incident-1",
    interaction: {
      channel: "pr_comment",
      author: "reviewer[bot]",
      text: "Add a regression test.",
      occurredAt: NOW.toISOString(),
    },
    dedupeKey: "github:review-1",
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "accepted", action: "steer" });
  const recorded = writes.find((write) => write.table === schema.incidentEvents);
  assert.equal(recorded?.kind, "github_comment");
});

test("incident-wide dedupe survives a predecessor-to-successor handoff", async () => {
  const { db, calls, writes } = lockedInboundDb({
    latestRun: {
      id: "successor-1",
      state: "running",
      trigger: "pr_closed",
      triggerDetail: { interactions: [] },
      providerSessionId: "session-2",
      completedAt: null,
      runtime: "anthropic",
    },
    existingDedupeEvent: { id: "reply-on-predecessor" },
  });

  const result = await recordInboundInteraction(db, {
    incidentId: "incident-1",
    interaction: {
      channel: "slack_reply",
      author: "alice",
      text: "Please keep working.",
      occurredAt: NOW.toISOString(),
    },
    dedupeKey: "slack:reply-1",
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "duplicate" });
  assert.ok(calls.indexOf("incident.lock") < calls.indexOf("dedupe.lookup"));
  assert.deepEqual(writes, []);
});

test("existing-session-only reply stays pending when the successor already started", async () => {
  const { db, writes } = lockedInboundDb({
    latestRun: {
      id: "successor-1",
      state: "repo_discovery",
      trigger: "pr_closed",
      triggerDetail: { interactions: [] },
      providerSessionId: null,
      completedAt: null,
      runtime: "anthropic",
    },
  });

  const result = await recordInboundInteraction(db, {
    incidentId: "incident-1",
    interaction: {
      channel: "pr_merged",
      author: "alice",
      text: "PR #1 merged.",
      occurredAt: NOW.toISOString(),
    },
    dedupeKey: "agent_pr_merged:pr-1",
    existingSessionOnly: true,
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "accepted", action: "steer" });
  const pendingEvent = writes.find((write) => write.table === schema.incidentEvents);
  assert.equal(pendingEvent?.agentRunId, "successor-1");
  assert.equal(pendingEvent?.processedAt, undefined);
});

test("existing-session-only lifecycle events do not park on unconsumable follow-up states", async (t) => {
  for (const state of ["superseded", "blocked_no_github"] as const) {
    await t.test(state, async () => {
      const { db, writes } = lockedInboundDb({
        latestRun: {
          id: "successor-1",
          state,
          trigger: "pr_closed",
          triggerDetail: { interactions: [] },
          providerSessionId: null,
          completedAt: null,
          runtime: "anthropic",
        },
      });

      const result = await recordInboundInteraction(db, {
        incidentId: "incident-1",
        interaction: {
          channel: "pr_merged",
          author: "alice",
          text: "PR #1 merged.",
          occurredAt: NOW.toISOString(),
        },
        dedupeKey: `agent_pr_merged:pr-1:${state}`,
        existingSessionOnly: true,
        now: NOW,
      });

      assert.deepEqual(result, { outcome: "skipped", reason: "no_resumable_session" });
      assert.deepEqual(writes, []);
    });
  }
});

test("a direct follow-up does not enqueue behind a resuming run", async () => {
  const { db, writes } = lockedInboundDb({
    latestRun: {
      id: "resuming-1",
      state: "resuming",
      trigger: "pr_closed",
      triggerDetail: { interactions: [] },
      providerSessionId: "session-1",
      completedAt: null,
      runtime: "anthropic",
    },
    priorRun: {
      id: "prior-1",
      state: "complete",
      trigger: "incident",
      triggerDetail: null,
      providerSessionId: "session-0",
      completedAt: NOW,
      runtime: "anthropic",
    },
  });

  const result = await requestFollowUpAgentRun(db, {
    incidentId: "incident-1",
    trigger: "slack_reply",
    interaction: {
      channel: "slack_reply",
      author: "alice",
      text: "Please check the latest deploy.",
      occurredAt: NOW.toISOString(),
    },
    now: NOW,
  });

  assert.deepEqual(result, { outcome: "skipped", reason: "run_active" });
  assert.deepEqual(writes, []);
});

test("restart preserves durable termination work for the superseded provider session", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    const active = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "test",
          state: "running",
          providerSessionId: "session-before-restart",
          providerSessionStatus: "running",
        })
        .returning(),
    );

    const result = await restartAgentRun(db, {
      incidentId: incident.id,
      runtime: "test",
      now: NOW,
    });

    assert.equal(result.outcome, "restarted");
    const after = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, active.id)),
    );
    assert.equal(after.state, "superseded");
    assert.equal(after.providerSessionStatus, "termination_pending");
  } finally {
    await client.close();
  }
});

test("restart rejects a stale expected latest run without superseding its successor", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident, priorRun } = await seedFollowUpIncident(db);
    const successor = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "test",
          state: "running",
        })
        .returning(),
    );

    const result = await restartAgentRun(db, {
      incidentId: incident.id,
      runtime: "test",
      expectedLatestRunId: priorRun.id,
      now: NOW,
    });

    assert.deepEqual(result, { outcome: "latest_run_changed" });
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(runs.length, 2);
    assert.equal(runs.find((run) => run.id === successor.id)?.state, "running");
  } finally {
    await client.close();
  }
});

test("restart transfers an unprocessed PR lifecycle event to its viable successor", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    const active = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "test",
          state: "running",
          providerSessionId: "session-before-lifecycle-restart",
        })
        .returning(),
    );
    const interaction = {
      channel: "pr_merged" as const,
      author: "alice",
      text: "PR #42 merged.",
      occurredAt: NOW.toISOString(),
    };
    await db.insert(schema.incidentEvents).values({
      incidentId: incident.id,
      agentRunId: active.id,
      kind: "human_reply",
      summary: interaction.text,
      detail: { origin: interaction },
      dedupeKey: "agent_pr_merged:pr-42",
    });

    const restart = await restartAgentRun(db, {
      incidentId: incident.id,
      runtime: "test",
      now: NOW,
    });

    assert.equal(restart.outcome, "restarted");
    if (restart.outcome !== "restarted") return;
    const pending = await db.query.incidentEvents.findFirst({
      where: eq(schema.incidentEvents.dedupeKey, "agent_pr_merged:pr-42"),
    });
    assert.equal(pending?.agentRunId, restart.agentRun.id);
    assert.equal(pending?.processedAt, null);

    const redelivery = await recordInboundInteraction(db, {
      incidentId: incident.id,
      interaction,
      dedupeKey: "agent_pr_merged:pr-42",
      existingSessionOnly: true,
      now: NOW,
    });
    assert.deepEqual(redelivery, { outcome: "duplicate" });
  } finally {
    await client.close();
  }
});

test("restart and resolution cannot leave a queued run on a closed Incident", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
  const { createIncidentLifecycle } = await import("./resolve-incident.js");
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    const [restart, resolution] = await Promise.all([
      restartAgentRun(db, { incidentId: incident.id, runtime: "test", now: NOW }),
      createIncidentLifecycle(db).resolve({
        incidentId: incident.id,
        kind: "dashboard_manual",
        reasonCode: "problem_resolved",
        reasonText: null,
        resolvedAt: NOW,
      }),
    ]);

    assert.equal(resolution.resolved, true);
    assert.ok(restart.outcome === "restarted" || restart.outcome === "incident_not_open");
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(
      runs.filter((run) => !["complete", "failed", "superseded"].includes(run.state)).length,
      0,
    );
  } finally {
    await client.close();
  }
});

test("restart serializes with follow-up creation and leaves one active successor", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident } = await seedFollowUpIncident(db);
    const [restart, followUp] = await Promise.all([
      restartAgentRun(db, { incidentId: incident.id, runtime: "test", now: NOW }),
      requestFollowUpAgentRun(db, {
        incidentId: incident.id,
        trigger: "slack_reply",
        interaction: {
          channel: "slack_reply",
          author: "alice",
          text: "Please retry the investigation.",
          occurredAt: NOW.toISOString(),
        },
        confirmed: true,
        now: NOW,
      }),
    ]);

    assert.equal(restart.outcome, "restarted");
    assert.ok(followUp.outcome === "enqueued" || followUp.outcome === "skipped");
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(
      runs.filter((run) => !["complete", "failed", "superseded"].includes(run.state)).length,
      1,
    );
  } finally {
    await client.close();
  }
});

test("concurrent retries of a GitHub-blocked run create one viable successor", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident, priorRun } = await seedFollowUpIncident(db);
    await db
      .update(schema.agentRuns)
      .set({ createdAt: RECENT })
      .where(eq(schema.agentRuns.id, priorRun.id));
    const blocked = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "anthropic",
          state: "blocked_no_github",
          createdAt: NOW,
        })
        .returning(),
    );

    const results = await Promise.all([
      retryBlockedAgentRun(db, { incidentId: incident.id, now: NOW }),
      retryBlockedAgentRun(db, { incidentId: incident.id, now: NOW }),
    ]);

    assert.equal(results.filter((result) => result.outcome === "retried").length, 1);
    assert.equal(results.filter((result) => result.outcome === "not_blocked").length, 1);
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(runs.find((run) => run.id === blocked.id)?.state, "superseded");
    const viable = runs.filter((run) => !["complete", "failed", "superseded"].includes(run.state));
    assert.equal(viable.length, 1);
    assert.equal(viable[0]?.state, "queued");
    assert.equal(viable[0]?.runtime, "anthropic");
  } finally {
    await client.close();
  }
});

test("retry preserves the blocked follow-up trigger context and prompt", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident, priorRun } = await seedFollowUpIncident(db);
    await db
      .update(schema.agentRuns)
      .set({ createdAt: RECENT })
      .where(eq(schema.agentRuns.id, priorRun.id));
    const triggerDetail = {
      interactions: [
        {
          channel: "slack_reply" as const,
          author: "alice",
          text: "Please investigate the latest deploy.",
          occurredAt: NOW.toISOString(),
        },
      ],
      pullRequests: [],
    };
    await db.insert(schema.agentRuns).values({
      incidentId: incident.id,
      runtime: "anthropic",
      state: "blocked_no_github",
      trigger: "slack_reply",
      triggerDetail,
      prompt: "Focus on the authentication regression.",
      createdAt: NOW,
    });

    const result = await retryBlockedAgentRun(db, { incidentId: incident.id, now: NOW });

    assert.equal(result.outcome, "retried");
    if (result.outcome !== "retried") return;
    assert.equal(result.agentRun.trigger, "slack_reply");
    assert.deepEqual(result.agentRun.triggerDetail, triggerDetail);
    assert.equal(result.agentRun.prompt, "Focus on the authentication regression.");
  } finally {
    await client.close();
  }
});

test("retry does not bypass disabled project agent runs", async () => {
  const { db, client } = await freshFollowUpDb();
  try {
    const { incident, priorRun } = await seedFollowUpIncident(db);
    await db
      .update(schema.agentRuns)
      .set({ createdAt: RECENT })
      .where(eq(schema.agentRuns.id, priorRun.id));
    const blocked = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "anthropic",
          state: "blocked_no_github",
          createdAt: NOW,
        })
        .returning(),
    );
    await db.insert(schema.projectAutomationSettings).values({
      projectId: incident.projectId,
      agentRunEnabled: false,
    });

    const result = await retryBlockedAgentRun(db, { incidentId: incident.id, now: NOW });

    assert.deepEqual(result, { outcome: "agent_runs_disabled" });
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(runs.find((run) => run.id === blocked.id)?.state, "blocked_no_github");
    assert.equal(runs.length, 2);
  } finally {
    await client.close();
  }
});
