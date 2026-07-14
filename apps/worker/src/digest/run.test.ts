import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DigestCandidate, DigestPick } from "./domain.js";
import { DEFAULT_DIGEST_POLICY, type DigestPolicy } from "./policy.js";
import type { DigestRepository, ProjectDigestSettings } from "./repository.js";
import {
  type DigestSlackPoster,
  type RunDigestForProjectDeps,
  type RunDigestsTickDeps,
  runDigestForProjectWorkflow,
  runDigestsTickWorkflow,
} from "./run.js";

const NOW = new Date("2026-05-23T10:00:00Z");

function makeCandidate(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    agentRunId: "run-1",
    incidentId: "inc-1",
    incidentCodename: "purple-otter",
    incidentTitle: "DB unreachable",
    projectName: "Acme",
    service: "api",
    severity: "SEV-2",
    completedAt: new Date("2026-05-22T10:00:00Z"),
    summary: "Reconnect missed transient ECONNREFUSED",
    rootCause: "no retry in pool acquire",
    estimatedImpact: "checkout broken",
    pr: {
      id: "pr-1",
      repoFullName: "acme/api",
      number: 42,
      title: "fix",
      url: "https://github.com/acme/api/pull/42",
      branch: "fix",
      baseBranch: "main",
      openedAt: new Date("2026-05-22T11:00:00Z"),
    },
    ...overrides,
  };
}

function makeRepo(opts: {
  calls: string[];
  settings?: Partial<ProjectDigestSettings>;
  installation?: { id: string; botAccessToken: string };
  candidates?: DigestCandidate[];
  enabledSettings?: ProjectDigestSettings[];
}): DigestRepository {
  return {
    async findProjectSettings(projectId) {
      opts.calls.push(`findProjectSettings:${projectId}`);
      return opts.settings === undefined
        ? undefined
        : {
            projectId,
            enabled: true,
            installationId: "inst-1",
            channelId: "C1",
            lastRunAt: null,
            runRequestedAt: null,
            ...opts.settings,
          };
    },
    async findActiveSlackInstallation(id) {
      opts.calls.push(`findActiveSlackInstallation:${id}`);
      return opts.installation;
    },
    async listRunnableProjectSettings() {
      opts.calls.push("listRunnableProjectSettings");
      return opts.enabledSettings ?? [];
    },
    async stampLastRun(projectId, at) {
      opts.calls.push(`stampLastRun:${projectId}:${at.toISOString()}`);
    },
    async clearRunRequest(projectId, requestedAt) {
      opts.calls.push(`clearRunRequest:${projectId}:${requestedAt.toISOString()}`);
    },
    async gatherCandidates(projectId, _policy, _now) {
      opts.calls.push(`gatherCandidates:${projectId}`);
      return opts.candidates ?? [];
    },
  };
}

function makeSlack(opts: { calls: string[]; ok?: boolean; ts?: string }): DigestSlackPoster {
  return {
    async postDigest(input) {
      opts.calls.push(`postDigest:${input.channelId}`);
      if (opts.ok === false) return { ok: false, error: "channel_not_found" };
      return { ok: true, ts: opts.ts ?? "1700000000.0001" };
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

function makeDeps(opts: {
  calls: string[];
  repo: DigestRepository;
  slack: DigestSlackPoster;
  picks?: DigestPick[];
  policy?: DigestPolicy;
}): RunDigestForProjectDeps {
  return {
    repo: opts.repo,
    slack: opts.slack,
    logger: makeLogger(opts.calls),
    policy: opts.policy ?? DEFAULT_DIGEST_POLICY,
    now: () => NOW,
    async rank(candidates) {
      opts.calls.push(`rank:${candidates.length}`);
      return opts.picks ?? candidates.map((c) => ({ agentRunId: c.agentRunId, rationale: "ok" }));
    },
  };
}

const INSTALLATION = {
  id: "inst-1",
  botAccessToken: "xoxb-fake",
};

test("runDigestForProject: full happy path posts and stamps last-run", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: {},
    installation: INSTALLATION,
    candidates: [makeCandidate(), makeCandidate({ agentRunId: "run-2" })],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps);
  assert.deepEqual(result, { status: "posted", pickCount: 2, ts: "1700000000.0001" });
  assert.ok(calls.includes(`stampLastRun:project-1:${NOW.toISOString()}`));
  assert.ok(calls.includes("postDigest:C1"));
});

test("runDigestForProject: skipped when no settings row", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-x", deps);
  assert.deepEqual(result, { status: "skipped", reason: "no project settings row" });
});

test("runDigestForProject: skipped when disabled (and not forced)", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls, settings: { enabled: false } });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps);
  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
});

test("runDigestForProject: force=true bypasses the enabled gate", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: { enabled: false },
    installation: INSTALLATION,
    candidates: [makeCandidate()],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps, { force: true });
  assert.equal(result.status, "posted");
});

test("runDigestForProject: still stamps last-run when there are no candidates", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: {},
    installation: INSTALLATION,
    candidates: [],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps);
  assert.equal(result.status, "skipped");
  assert.ok(calls.includes(`stampLastRun:project-1:${NOW.toISOString()}`));
});

test("runDigestForProject: a forced test posts an empty digest when there are no candidates", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: { enabled: false },
    installation: INSTALLATION,
    candidates: [],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps, { force: true });

  assert.deepEqual(result, { status: "posted", pickCount: 0, ts: "1700000000.0001" });
  assert.ok(calls.includes("postDigest:C1"));
  assert.ok(calls.includes(`stampLastRun:project-1:${NOW.toISOString()}`));
});

test("runDigestForProject: does NOT stamp last-run when Slack post fails", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: {},
    installation: INSTALLATION,
    candidates: [makeCandidate()],
  });
  const slack = makeSlack({ calls, ok: false });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps);
  assert.equal(result.status, "skipped");
  assert.ok(!calls.some((c) => c.startsWith("stampLastRun")));
  assert.ok(calls.includes("logger.warn:digest post failed; not stamping last-run"));
});

test("runDigestForProject: skipped when slack installation is revoked/missing", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls, settings: {} });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForProjectWorkflow("project-1", deps);
  assert.deepEqual(result, {
    status: "skipped",
    reason: "slack installation revoked or missing",
  });
});

test("tickDigests: applies long-cadence and short retry-cooldown per project", async () => {
  const calls: string[] = [];
  const fiveMinAgo = new Date(NOW.getTime() - 5 * 60 * 1000);
  const oneDayAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const enabled = [
    {
      projectId: "fresh",
      enabled: true,
      channelId: "C1",
      installationId: "inst-1",
      lastRunAt: null,
      runRequestedAt: null,
    },
    {
      projectId: "recent",
      enabled: true,
      channelId: "C2",
      installationId: "inst-1",
      lastRunAt: oneDayAgo,
      runRequestedAt: null,
    }, // long-cadence skip (not yet 7d)
    {
      projectId: "cooldown",
      enabled: true,
      channelId: "C3",
      installationId: "inst-1",
      lastRunAt: null,
      runRequestedAt: null,
    },
  ];
  const repo = makeRepo({ calls, enabledSettings: enabled });
  const slack = makeSlack({ calls });
  const lastAttemptByProject = new Map<string, number>([["cooldown", fiveMinAgo.getTime() + 1000]]);
  const deps: RunDigestsTickDeps = {
    ...makeDeps({ calls, repo, slack }),
    lastAttemptByProject,
  };

  const projectRuns: string[] = [];
  const processed = await runDigestsTickWorkflow(deps, async (projectId) => {
    projectRuns.push(projectId);
    return { status: "posted", pickCount: 1, ts: "x" };
  });
  assert.equal(processed, 1);
  assert.deepEqual(projectRuns, ["fresh"]);
  assert.ok(lastAttemptByProject.has("fresh"));
});

test("tickDigests: a manual request runs immediately without enabling the weekly schedule", async () => {
  const calls: string[] = [];
  const oneDayAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const requested = [
    {
      projectId: "manual",
      enabled: false,
      channelId: "C1",
      installationId: "inst-1",
      lastRunAt: oneDayAgo,
      runRequestedAt: NOW,
    },
  ];
  const repo = makeRepo({ calls, enabledSettings: requested });
  const slack = makeSlack({ calls });
  const deps: RunDigestsTickDeps = {
    ...makeDeps({ calls, repo, slack }),
    // A manual test must bypass the retry cooldown left by a recent scheduled
    // attempt; otherwise "Send test now" could silently wait several minutes.
    lastAttemptByProject: new Map([["manual", NOW.getTime() - 1000]]),
  };

  const projectRuns: Array<{ projectId: string; force: boolean }> = [];
  await runDigestsTickWorkflow(deps, async (projectId: string, opts?: { force?: boolean }) => {
    projectRuns.push({ projectId, force: opts?.force === true });
    return { status: "posted", pickCount: 1, ts: "x" };
  });

  assert.deepEqual(projectRuns, [{ projectId: "manual", force: true }]);
  assert.ok(calls.includes(`clearRunRequest:manual:${NOW.toISOString()}`));
});

test("tickDigests: a failed manual attempt is consumed instead of retrying every tick", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    enabledSettings: [
      {
        projectId: "manual",
        enabled: false,
        channelId: "C1",
        installationId: "inst-1",
        lastRunAt: null,
        runRequestedAt: NOW,
      },
    ],
  });
  const deps: RunDigestsTickDeps = {
    ...makeDeps({ calls, repo, slack: makeSlack({ calls }) }),
    lastAttemptByProject: new Map(),
  };

  await runDigestsTickWorkflow(deps, async () => ({
    status: "skipped",
    reason: "slack error: channel_not_found",
  }));

  assert.ok(calls.includes(`clearRunRequest:manual:${NOW.toISOString()}`));
});
