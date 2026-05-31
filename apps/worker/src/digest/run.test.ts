import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import type { DigestCandidate, DigestPick } from "./domain.js";
import { DEFAULT_DIGEST_POLICY, type DigestPolicy } from "./policy.js";
import type { DigestRepository } from "./repository.js";
import {
  type DigestSlackPoster,
  type RunDigestForOrgDeps,
  type RunDigestsTickDeps,
  runDigestForOrgWorkflow,
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
  settings?: Partial<schema.OrgAgentSettings>;
  installation?: schema.SlackInstallation;
  candidates?: DigestCandidate[];
  enabledSettings?: schema.OrgAgentSettings[];
}): DigestRepository {
  return {
    async findOrgSettings(orgId) {
      opts.calls.push(`findOrgSettings:${orgId}`);
      return opts.settings === undefined
        ? undefined
        : ({
            orgId,
            digestEnabled: true,
            digestSlackInstallationId: "inst-1",
            digestSlackChannelId: "C1",
            digestLastRunAt: null,
            ...opts.settings,
          } as schema.OrgAgentSettings);
    },
    async findActiveSlackInstallation(id) {
      opts.calls.push(`findActiveSlackInstallation:${id}`);
      return opts.installation;
    },
    async listEnabledDigestSettings() {
      opts.calls.push("listEnabledDigestSettings");
      return opts.enabledSettings ?? [];
    },
    async stampLastRun(orgId, at) {
      opts.calls.push(`stampLastRun:${orgId}:${at.toISOString()}`);
    },
    async gatherCandidates(orgId, _policy, _now) {
      opts.calls.push(`gatherCandidates:${orgId}`);
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
}): RunDigestForOrgDeps {
  return {
    repo: opts.repo,
    slack: opts.slack,
    logger: makeLogger(opts.calls),
    policy: opts.policy ?? DEFAULT_DIGEST_POLICY,
    now: () => NOW,
    async rank(candidates) {
      opts.calls.push(`rank:${candidates.length}`);
      return (
        opts.picks ??
        candidates.map((c) => ({ agentRunId: c.agentRunId, rationale: "ok" }))
      );
    },
  };
}

const INSTALLATION: schema.SlackInstallation = {
  id: "inst-1",
  botAccessToken: "xoxb-fake",
} as schema.SlackInstallation;

test("runDigestForOrg: full happy path posts and stamps last-run", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: {},
    installation: INSTALLATION,
    candidates: [makeCandidate(), makeCandidate({ agentRunId: "run-2" })],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-1", deps);
  assert.deepEqual(result, { status: "posted", pickCount: 2, ts: "1700000000.0001" });
  assert.ok(calls.includes(`stampLastRun:org-1:${NOW.toISOString()}`));
  assert.ok(calls.includes("postDigest:C1"));
});

test("runDigestForOrg: skipped when no settings row", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-x", deps);
  assert.deepEqual(result, { status: "skipped", reason: "no org_agent_settings row" });
});

test("runDigestForOrg: skipped when disabled (and not forced)", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls, settings: { digestEnabled: false } });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-1", deps);
  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
});

test("runDigestForOrg: force=true bypasses the digestEnabled gate", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: { digestEnabled: false },
    installation: INSTALLATION,
    candidates: [makeCandidate()],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-1", deps, { force: true });
  assert.equal(result.status, "posted");
});

test("runDigestForOrg: still stamps last-run when there are no candidates", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: {},
    installation: INSTALLATION,
    candidates: [],
  });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-1", deps);
  assert.equal(result.status, "skipped");
  assert.ok(calls.includes(`stampLastRun:org-1:${NOW.toISOString()}`));
});

test("runDigestForOrg: does NOT stamp last-run when Slack post fails", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    settings: {},
    installation: INSTALLATION,
    candidates: [makeCandidate()],
  });
  const slack = makeSlack({ calls, ok: false });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-1", deps);
  assert.equal(result.status, "skipped");
  assert.ok(!calls.some((c) => c.startsWith("stampLastRun")));
  assert.ok(calls.includes("logger.warn:digest post failed; not stamping last-run"));
});

test("runDigestForOrg: skipped when slack installation is revoked/missing", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls, settings: {} });
  const slack = makeSlack({ calls });
  const deps = makeDeps({ calls, repo, slack });

  const result = await runDigestForOrgWorkflow("org-1", deps);
  assert.deepEqual(result, {
    status: "skipped",
    reason: "slack installation revoked or missing",
  });
});

test("tickDigests: applies long-cadence and short retry-cooldown per org", async () => {
  const calls: string[] = [];
  const fiveMinAgo = new Date(NOW.getTime() - 5 * 60 * 1000);
  const oneDayAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const enabled = [
    {
      orgId: "fresh",
      digestEnabled: true,
      digestSlackChannelId: "C1",
      digestSlackInstallationId: "inst-1",
      digestLastRunAt: null,
    } as schema.OrgAgentSettings,
    {
      orgId: "recent",
      digestEnabled: true,
      digestSlackChannelId: "C2",
      digestSlackInstallationId: "inst-1",
      digestLastRunAt: oneDayAgo,
    } as schema.OrgAgentSettings, // long-cadence skip (not yet 7d)
    {
      orgId: "cooldown",
      digestEnabled: true,
      digestSlackChannelId: "C3",
      digestSlackInstallationId: "inst-1",
      digestLastRunAt: null,
    } as schema.OrgAgentSettings,
  ];
  const repo = makeRepo({ calls, enabledSettings: enabled });
  const slack = makeSlack({ calls });
  const lastAttemptByOrg = new Map<string, number>([["cooldown", fiveMinAgo.getTime() + 1000]]);
  const deps: RunDigestsTickDeps = {
    ...makeDeps({ calls, repo, slack }),
    lastAttemptByOrg,
  };

  const orgRuns: string[] = [];
  const processed = await runDigestsTickWorkflow(deps, async (orgId) => {
    orgRuns.push(orgId);
    return { status: "posted", pickCount: 1, ts: "x" };
  });
  assert.equal(processed, 1);
  assert.deepEqual(orgRuns, ["fresh"]);
  assert.ok(lastAttemptByOrg.has("fresh"));
});
