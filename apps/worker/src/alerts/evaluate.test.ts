import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import { type EvaluateAlertDeps, evaluateAlertWorkflow, runAlertsTick } from "./evaluate.js";
import type {
  AlertRepository,
  EpisodeIssueUpsertInput,
  EpisodeOpenInput,
  EpisodeTouchInput,
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
  upsertInserted?: boolean;
  upsertThrows?: boolean;
  openEpisodeThrows?: boolean;
  closeEpisodeThrows?: boolean;
  capturedFirings?: FiringRecord[];
  capturedOpens?: EpisodeOpenInput[];
  capturedUpserts?: EpisodeIssueUpsertInput[];
  capturedTouches?: EpisodeTouchInput[];
  dueAlerts?: schema.Alert[];
  incidentIdForIssue?: string | null;
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
    async openOrContinueEpisode(input) {
      opts.calls.push(`openOrContinueEpisode:${input.groupKey || "*"}`);
      opts.capturedOpens?.push(input);
      if (opts.openEpisodeThrows) throw new Error("episode-boom");
      return { episodeId: "ep-1" };
    },
    async upsertEpisodeIssue(input) {
      opts.calls.push(`upsertEpisodeIssue:${input.episodeId}`);
      opts.capturedUpserts?.push(input);
      if (opts.upsertThrows) throw new Error("boom");
      return {
        issue: { id: "issue-1", title: input.title } as schema.Issue,
        inserted: opts.upsertInserted ?? true,
      };
    },
    async setEpisodeIncident(episodeId, incidentId) {
      opts.calls.push(`setEpisodeIncident:${episodeId}:${incidentId}`);
    },
    async withIssueIntakeLock(issueId, fn) {
      opts.calls.push(`withIssueIntakeLock:${issueId}`);
      return fn();
    },
    async recordFiring(record) {
      opts.calls.push(
        `recordFiring:${record.groupKey || "*"}:${record.state}:${record.issueId ?? "null"}`,
      );
      opts.capturedFirings?.push(record);
    },
    async findIncidentIdForIssue(issueId) {
      opts.calls.push(`findIncidentIdForIssue:${issueId}`);
      return opts.incidentIdForIssue ?? null;
    },
    async touchOpenEpisode(input) {
      opts.calls.push(`touchOpenEpisode:${input.groupKey || "*"}`);
      opts.capturedTouches?.push(input);
    },
    async closeOpenEpisode(input) {
      opts.calls.push(`closeOpenEpisode:${input.groupKey || "*"}`);
      if (opts.closeEpisodeThrows) throw new Error("close-boom");
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

test("evaluateAlertWorkflow: first-time firing opens the episode first, then raises its issue", async () => {
  const calls: string[] = [];
  const opens: EpisodeOpenInput[] = [];
  const upserts: EpisodeIssueUpsertInput[] = [];
  const repo = makeRepoFake({ calls, capturedOpens: opens, capturedUpserts: upserts });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.deepEqual(calls, [
    "aggregate",
    "getLatestFiringState:alert-1:",
    "logger.warn:alert firing",
    "openOrContinueEpisode:*",
    "upsertEpisodeIssue:ep-1",
    "withIssueIntakeLock:issue-1",
    "handleIssueTransition:issue-1:new",
    "findIncidentIdForIssue:issue-1",
    "recordFiring:*:firing:issue-1",
    "markEvaluated:alert-1",
  ]);
  assert.equal(opens[0]?.startedAt, FIXED_NOW);
  assert.equal(opens[0]?.observedValue, 20);
  assert.equal(upserts[0]?.episodeId, "ep-1");
  assert.equal(upserts[0]?.title, "Errors > 10 (observed=20)");
});

test("evaluateAlertWorkflow: new firing points the episode at the issue's incident", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, incidentIdForIssue: "inc-1" });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.ok(calls.includes("findIncidentIdForIssue:issue-1"));
  assert.ok(calls.includes("setEpisodeIncident:ep-1:inc-1"));
});

test("evaluateAlertWorkflow: retried tick notifies again even when the issue upsert folded", async () => {
  // A previous attempt may have died after creating the issue but before
  // incident intake ran; the retry must not skip handleIssueTransition.
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, upsertInserted: false });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.ok(calls.includes("handleIssueTransition:issue-1:new"));
});

test("evaluateAlertWorkflow: still-firing touches the episode (which mirrors onto its issue)", async () => {
  const calls: string[] = [];
  const touches: EpisodeTouchInput[] = [];
  const repo = makeRepoFake({
    calls,
    previousStates: new Map([["", "firing"]]),
    capturedTouches: touches,
  });
  const deps = makeDeps({ calls, repo });

  await evaluateAlertWorkflow(makeAlert(), deps);

  assert.deepEqual(calls, [
    "aggregate",
    "getLatestFiringState:alert-1:",
    "touchOpenEpisode:*",
    "recordFiring:*:firing:null",
    "markEvaluated:alert-1",
  ]);
  assert.equal(touches[0]?.observedValue, 20);
  assert.equal(touches[0]?.lastSample.exceptionType, "AlertFired");
});

test("evaluateAlertWorkflow: recovery closes the episode before recording ok", async () => {
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

test("evaluateAlertWorkflow: episode-open failure propagates so the next tick retries (does NOT record firing or mark evaluated)", async () => {
  // The episode is now the paging-critical trigger record: swallowing its
  // failure would record a firing row with issueId=null and stamp
  // lastEvaluatedAt — a firing alert that pages nobody, forever.
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, openEpisodeThrows: true });
  const deps = makeDeps({ calls, repo });

  await assert.rejects(evaluateAlertWorkflow(makeAlert(), deps), /episode-boom/);

  assert.ok(!calls.some((c) => c.startsWith("upsertEpisodeIssue")));
  assert.ok(!calls.some((c) => c.startsWith("recordFiring")));
  assert.ok(!calls.some((c) => c.startsWith("markEvaluated")));
});

test("evaluateAlertWorkflow: issue-upsert failure propagates so the next tick retries", async () => {
  const calls: string[] = [];
  const repo = makeRepoFake({ calls, upsertThrows: true });
  const deps = makeDeps({ calls, repo });

  await assert.rejects(evaluateAlertWorkflow(makeAlert(), deps), /boom/);

  assert.ok(!calls.some((c) => c.startsWith("recordFiring")));
  assert.ok(!calls.some((c) => c.startsWith("markEvaluated")));
});

test("evaluateAlertWorkflow: episode-close failure propagates so recovery is retried next tick", async () => {
  // If the close were swallowed, recordFiring('ok') would flip the observed
  // state and the next tick would classify still_ok — the episode would stay
  // open until the stale-open net caught it on the next breach.
  const calls: string[] = [];
  const repo = makeRepoFake({
    calls,
    previousStates: new Map([["", "firing"]]),
    closeEpisodeThrows: true,
  });
  const deps = makeDeps({
    calls,
    repo,
    async aggregate() {
      calls.push("aggregate");
      return new Map([["", 0]]);
    },
  });

  await assert.rejects(evaluateAlertWorkflow(makeAlert(), deps), /close-boom/);

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

  await evaluateAlertWorkflow(makeAlert({ groupMode: "per_group", groupBy: "service.name" }), deps);

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
