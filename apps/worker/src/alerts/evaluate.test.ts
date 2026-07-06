import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  type EvaluateAlertDeps,
  evaluateAlertWorkflow,
  runAlertsTick,
} from "./evaluate.js";
import type {
  AlertIssueUpsertInput,
  AlertIssueUpsertResult,
  AlertRepository,
  FiringRecord,
} from "./repository.js";

const FIXED_NOW = new Date("2026-05-23T10:00:00Z");

function makeAlert(overrides: Partial<schema.Alert> = {}): schema.Alert {
  return {
    id: "alert-1",
    projectId: "project-1",
    name: "Errors",
    enabled: true,
    source: "logs",
    metricName: null,
    filter: {},
    groupBy: null,
    groupMode: "single",
    aggregation: "sum",
    comparator: "gt",
    threshold: 10,
    windowMinutes: 5,
    evaluationIntervalSeconds: 60,
    createdBy: "user-1",
    lastEvaluatedAt: null,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  } satisfies schema.Alert;
}

function makeRepoFake(opts: {
  calls: string[];
  previousStates?: Map<string, "firing" | "ok">;
  upsertResult?: AlertIssueUpsertResult;
  upsertThrows?: boolean;
  capturedFirings?: FiringRecord[];
  capturedUpserts?: AlertIssueUpsertInput[];
  dueAlerts?: schema.Alert[];
  incidentIdForIssue?: string | null;
  episodeThrows?: boolean;
}): AlertRepository {
  return {
    async listDueAlerts() {
      opts.calls.push("listDueAlerts");
      return opts.dueAlerts ?? [];
    },
    async getLatestFiringState(alertId, groupKey) {
      opts.calls.push(`getLatestFiringState:${alertId}:${groupKey}`);
      return opts.previousStates?.get(groupKey) ?? null;
    },
    async upsertAlertIssue(input) {
      opts.calls.push(`upsertAlertIssue:${input.fingerprint}`);
      opts.capturedUpserts?.push(input);
      if (opts.upsertThrows) throw new Error("boom");
      return (
        opts.upsertResult ?? {
          issue: { id: "issue-1", title: input.title } as schema.Issue,
          prevIssueId: null,
          prevIssueStatus: null,
        }
      );
    },
    async recordFiring(record) {
      opts.calls.push(`recordFiring:${record.groupKey || "*"}:${record.state}:${record.issueId ?? "null"}`);
      opts.capturedFirings?.push(record);
    },
    async findIncidentIdForIssue(issueId) {
      opts.calls.push(`findIncidentIdForIssue:${issueId}`);
      return opts.incidentIdForIssue ?? null;
    },
    async openEpisode(input) {
      opts.calls.push(`openEpisode:${input.groupKey || "*"}:${input.incidentId ?? "null"}`);
      if (opts.episodeThrows) throw new Error("episode-boom");
    },
    async touchOpenEpisode(input) {
      opts.calls.push(`touchOpenEpisode:${input.groupKey || "*"}`);
      if (opts.episodeThrows) throw new Error("episode-boom");
    },
    async closeOpenEpisode(input) {
      opts.calls.push(`closeOpenEpisode:${input.groupKey || "*"}`);
      if (opts.episodeThrows) throw new Error("episode-boom");
    },
    async markEvaluated(alertId, _at) {
      opts.calls.push(`markEvaluated:${alertId}`);
    },
  };
}

function makeLogger(calls: string[]) {
  return {
    info(_obj: Record<string, unknown>, msg?: string) {
      calls.push(`logger.info:${msg ?? ""}`);
    },
    warn(_obj: Record<string, unknown>, msg?: string) {
      calls.push(`logger.warn:${msg ?? ""}`);
    },
    error(_obj: Record<string, unknown>, msg?: string) {
      calls.push(`logger.error:${msg ?? ""}`);
    },
  };
}

function makeDeps(
  overrides: Partial<EvaluateAlertDeps> & { calls: string[]; repo: AlertRepository },
): EvaluateAlertDeps {
  const { calls, ...rest } = overrides;
  const defaults: EvaluateAlertDeps = {
    repo: overrides.repo,
    async aggregate(_alert, _range) {
      calls.push("aggregate");
      return new Map([["", 20]]);
    },
    async handleIssueTransition(issue, transition) {
      calls.push(`handleIssueTransition:${issue.id}:${transition}`);
    },
    logger: makeLogger(calls),
    now: () => FIXED_NOW,
  };
  return { ...defaults, ...rest };
}

test("evaluateAlertWorkflow: first-time firing creates issue and notifies as new", async () => {
  const calls: string[] = [];
  const upserts: AlertIssueUpsertInput[] = [];
  const repo = makeRepoFake({ calls, capturedUpserts: upserts });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.deepEqual(calls, [
    "aggregate",
    "getLatestFiringState:alert-1:",
    "logger.warn:alert firing",
    "upsertAlertIssue:alert:alert-1",
    "handleIssueTransition:issue-1:new",
    "findIncidentIdForIssue:issue-1",
    "openEpisode:*:null",
    "recordFiring:*:firing:issue-1",
    "markEvaluated:alert-1",
  ]);
  assert.equal(upserts[0]?.fingerprint, "alert:alert-1");
  assert.equal(upserts[0]?.title, "Errors > 10 (observed=20)");
});

test("evaluateAlertWorkflow: still-firing skips upsert and notification, just records", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, previousStates: new Map([["", "firing"]]) });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.deepEqual(calls, [
    "aggregate",
    "getLatestFiringState:alert-1:",
    "touchOpenEpisode:*",
    "recordFiring:*:firing:null",
    "markEvaluated:alert-1",
  ]);
});

test("evaluateAlertWorkflow: recovery logs and records ok without upsert", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, previousStates: new Map([["", "firing"]]) });
  const deps = makeDeps({
    calls,
    repo,
    async aggregate() {
      calls.push("aggregate");
      return new Map([["", 0]]);
    },
  });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.deepEqual(calls, [
    "aggregate",
    "getLatestFiringState:alert-1:",
    "logger.info:alert recovered",
    "closeOpenEpisode:*",
    "recordFiring:*:ok:null",
    "markEvaluated:alert-1",
  ]);
});

test("evaluateAlertWorkflow: still-ok records nothing extra", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, previousStates: new Map([["", "ok"]]) });
  const deps = makeDeps({
    calls,
    repo,
    async aggregate() {
      calls.push("aggregate");
      return new Map([["", 0]]);
    },
  });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.deepEqual(calls, [
    "aggregate",
    "getLatestFiringState:alert-1:",
    "recordFiring:*:ok:null",
    "markEvaluated:alert-1",
  ]);
});

test("evaluateAlertWorkflow: recurred transition fires handler with 'recurred'", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    upsertResult: {
      issue: { id: "issue-2" } as schema.Issue,
      prevIssueId: "issue-2",
      prevIssueStatus: "resolved",
    },
  });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.ok(calls.includes("handleIssueTransition:issue-2:recurred"));
});

test("evaluateAlertWorkflow: silenced issue suppresses the handler entirely", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    upsertResult: {
      issue: { id: "issue-4" } as schema.Issue,
      prevIssueId: "issue-4",
      prevIssueStatus: "silenced",
    },
  });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.ok(!calls.some((c) => c.startsWith("handleIssueTransition")));
});

test("evaluateAlertWorkflow: 'seen' transition does not notify but still records firing", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    upsertResult: {
      issue: { id: "issue-3" } as schema.Issue,
      prevIssueId: "issue-3",
      prevIssueStatus: "open",
    },
  });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.ok(!calls.some((c) => c.startsWith("handleIssueTransition")));
  assert.ok(calls.includes("recordFiring:*:firing:issue-3"));
});

test("evaluateAlertWorkflow: new firing opens an episode pointed at the resolved incident", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, incidentIdForIssue: "inc-1" });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.ok(calls.includes("findIncidentIdForIssue:issue-1"));
  assert.ok(calls.includes("openEpisode:*:inc-1"));
});

test("evaluateAlertWorkflow: episode write failure is non-fatal — firing is still recorded and the alert is marked evaluated", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, episodeThrows: true });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  // The episode op blew up but the paging-critical path is untouched.
  assert.ok(calls.includes("openEpisode:*:null"));
  assert.ok(calls.includes("logger.error:alert episode update failed"));
  assert.ok(calls.includes("recordFiring:*:firing:issue-1"));
  assert.ok(calls.includes("markEvaluated:alert-1"));
});

test("evaluateAlertWorkflow: upsert failure propagates so the next tick retries (does NOT record firing or mark evaluated)", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, upsertThrows: true });
  const deps = makeDeps({ calls, repo });

  await assert.rejects(evaluateAlertWorkflow(makeAlert(), deps), /boom/);

  // Critical: a firing row with issueId=null + markEvaluated would lock the
  // alert into a state where nobody is paged AND the next tick won't retry.
  assert.ok(!calls.some((c) => c.startsWith("recordFiring")));
  assert.ok(!calls.some((c) => c.startsWith("markEvaluated")));
});

test("runAlertsTick: upsert failure on one alert is caught and does not block the others", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    upsertThrows: true,
    dueAlerts: [makeAlert({ id: "a" }), makeAlert({ id: "b" })],
  });
  const deps: EvaluateAlertDeps & { listDueAlerts(): Promise<schema.Alert[]> } = {
    ...makeDeps({ calls, repo }),
    listDueAlerts: repo.listDueAlerts,
  };

  const processed = await runAlertsTick(deps);
  // Both alerts attempted to upsert (because upsertThrows always fires), so
  // neither was "processed" successfully — but the tick itself doesn't crash.
  assert.equal(processed, 0);
  assert.ok(calls.includes("logger.error:alert evaluation failed"));
});

test("evaluateAlertWorkflow: per_group mode evaluates each group independently", async () => {
  const calls: string[] = [];
  const firings: FiringRecord[] = [];
  const repo = makeRepoFake({
    calls,
    previousStates: new Map([
      ["api", "ok"],
      ["worker", "firing"],
    ]),
    capturedFirings: firings,
  });
  const deps = makeDeps({
    calls,
    repo,
    async aggregate() {
      calls.push("aggregate");
      return new Map([
        ["api", 50],
        ["worker", 2],
      ]);
    },
  });

  await evaluateAlertWorkflow(
    makeAlert({ groupMode: "per_group", groupBy: "service.name" }),
    deps,
  );

  const states = Object.fromEntries(firings.map((f) => [f.groupKey, f.state]));
  assert.deepEqual(states, { api: "firing", worker: "ok" });
});

test("runAlertsTick: evaluates each due alert and returns processed count", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    dueAlerts: [makeAlert({ id: "a" }), makeAlert({ id: "b" })],
  });
  const deps: EvaluateAlertDeps & { listDueAlerts(): Promise<schema.Alert[]> } = {
    ...makeDeps({ calls, repo }),
    listDueAlerts: repo.listDueAlerts,
  };

  const processed = await runAlertsTick(deps);
  assert.equal(processed, 2);
  assert.ok(calls.includes("markEvaluated:a"));
  assert.ok(calls.includes("markEvaluated:b"));
});

test("runAlertsTick: a failing alert does not prevent later alerts from running", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    dueAlerts: [makeAlert({ id: "a" }), makeAlert({ id: "b" })],
  });
  let firstCall = true;
  const deps: EvaluateAlertDeps & { listDueAlerts(): Promise<schema.Alert[]> } = {
    ...makeDeps({
      calls,
      repo,
      async aggregate() {
        calls.push("aggregate");
        if (firstCall) {
          firstCall = false;
          throw new Error("nope");
        }
        return new Map([["", 0]]);
      },
    }),
    listDueAlerts: repo.listDueAlerts,
  };

  const processed = await runAlertsTick(deps);
  assert.equal(processed, 1);
  assert.ok(calls.includes("logger.error:alert evaluation failed"));
  assert.ok(calls.includes("markEvaluated:b"));
});
