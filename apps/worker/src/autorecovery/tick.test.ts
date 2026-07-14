import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import type { CandidateIncident, ProposalToolInput } from "./domain.js";
import { DEFAULT_AUTORECOVERY_POLICY } from "./policy.js";
import type { AutorecoveryRepository } from "./repository.js";
import type { SlackPoster } from "./slack.js";
import {
  type TickDeps,
  evaluateIncident,
  runAutorecoveryNow,
  runAutorecoveryTick,
} from "./tick.js";

const NOW = new Date("2026-05-23T10:00:00Z");

function makeCandidate(overrides: Partial<CandidateIncident> = {}): CandidateIncident {
  return {
    id: "inc-1",
    projectId: "proj-1",
    title: "DB down",
    codename: "blue-eel",
    service: "api",
    firstSeen: new Date("2026-05-22T00:00:00Z"),
    lastSeen: new Date("2026-05-23T05:00:00Z"),
    issueCount: 4,
    issueSignatures: [{ exceptionType: "Error" }],
    slackChannelId: null,
    slackThreadTs: null,
    slackInstallationId: null,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalToolInput> = {}): ProposalToolInput {
  return {
    looks_resolved: true,
    confidence: "medium",
    reason_code: "external dependency recovered",
    reason_text: "Underlying service responsive for 6h",
    ...overrides,
  };
}

function makeRepo(opts: {
  calls: string[];
  project?: { id: string; orgId: string; name: string } | null;
  existingOpenProposal?: boolean;
  insertResult?: schema.IncidentResolutionProposal | null;
  slackInstallation?: schema.SlackInstallation;
  lastRun?: Date | null;
  candidates?: CandidateIncident[];
}): AutorecoveryRepository {
  return {
    async getLastRunAt() {
      opts.calls.push("getLastRunAt");
      return opts.lastRun ?? null;
    },
    async setLastRunAt(at) {
      opts.calls.push(`setLastRunAt:${at.toISOString()}`);
    },
    async markEvaluated(incidentId, at) {
      opts.calls.push(`markEvaluated:${incidentId}:${at.toISOString()}`);
    },
    async selectCandidates(_now, _policy, _opts) {
      opts.calls.push(`selectCandidates:${_opts?.ignoreThrottles ?? false}`);
      return opts.candidates ?? [];
    },
    async findProject(projectId) {
      opts.calls.push(`findProject:${projectId}`);
      return opts.project === undefined
        ? { id: projectId, orgId: "org-1", name: "Proj" }
        : (opts.project ?? undefined);
    },
    async findOpenProposalForIncident(incidentId) {
      opts.calls.push(`findOpenProposal:${incidentId}`);
      return opts.existingOpenProposal
        ? ({ id: "existing" } as schema.IncidentResolutionProposal)
        : undefined;
    },
    async insertProposal(input) {
      opts.calls.push(`insertProposal:${input.incident.id}:${input.proposal.confidence}`);
      return opts.insertResult === undefined
        ? ({
            id: "prop-1",
            incidentId: input.incident.id,
          } as schema.IncidentResolutionProposal)
        : opts.insertResult;
    },
    async setProposalSlackMessageTs(proposalId, ts) {
      opts.calls.push(`setProposalSlackMessageTs:${proposalId}:${ts}`);
    },
    async findSlackInstallation(id) {
      opts.calls.push(`findSlackInstallation:${id}`);
      return opts.slackInstallation;
    },
  };
}

function makeSlack(opts: { calls: string[]; ok?: boolean; ts?: string }): SlackPoster {
  return {
    async postProposal(input) {
      opts.calls.push(`postProposal:${input.proposalId}`);
      if (opts.ok === false) return { ok: false, error: "channel_not_found" };
      return { ok: true, ts: opts.ts ?? "1700000000.000100" };
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
  };
}

function makeDeps(opts: {
  calls: string[];
  repo: AutorecoveryRepository;
  slack?: SlackPoster;
  proposal?: ProposalToolInput | null;
  candidates?: CandidateIncident[];
}): TickDeps {
  const slack = opts.slack ?? makeSlack({ calls: opts.calls });
  return {
    policy: DEFAULT_AUTORECOVERY_POLICY,
    repo: opts.repo,
    slack,
    logger: makeLogger(opts.calls),
    async runAgent(_incident) {
      opts.calls.push(`runAgent:${_incident.id}`);
      return opts.proposal ?? null;
    },
    selectCandidates: opts.repo.selectCandidates,
    now: () => NOW,
  };
}

test("evaluateIncident: proposes and posts to Slack when all conditions met", async () => {
  const calls: string[] = [];
  const slack = makeSlack({ calls });
  const repo = makeRepo({
    calls,
    slackInstallation: {
      id: "inst-1",
      botAccessToken: "xoxb-fake",
    } as schema.SlackInstallation,
  });
  const incident = makeCandidate({
    slackChannelId: "C1",
    slackThreadTs: "1.0",
    slackInstallationId: "inst-1",
  });
  const deps = makeDeps({ calls, repo, slack, proposal: makeProposal() });

  const result = await evaluateIncident(incident, deps);

  assert.equal(result.kind, "proposed");
  assert.deepEqual(calls, [
    "findProject:proj-1",
    "runAgent:inc-1",
    "findOpenProposal:inc-1",
    "insertProposal:inc-1:medium",
    "findSlackInstallation:inst-1",
    "postProposal:prop-1",
    "setProposalSlackMessageTs:prop-1:1700000000.000100",
  ]);
});

test("evaluateIncident: skips when agent says not resolved", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const deps = makeDeps({
    calls,
    repo,
    proposal: makeProposal({ looks_resolved: false }),
  });

  const result = await evaluateIncident(makeCandidate(), deps);
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") assert.equal(result.reason, "still_happening");
  assert.ok(!calls.some((c) => c.startsWith("insertProposal")));
});

test("evaluateIncident: skips below-confidence", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const deps = makeDeps({
    calls,
    repo,
    proposal: makeProposal({ confidence: "low" }),
  });
  const result = await evaluateIncident(makeCandidate(), deps);
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") assert.equal(result.reason, "below_confidence");
});

test("evaluateIncident: skips and does not call agent when issueSignatures is empty", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });

  const result = await evaluateIncident(makeCandidate({ issueSignatures: [] }), deps);

  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") assert.equal(result.reason, "no_live_signatures");
  // Critical: the agent must NEVER see an incident with no signatures, or it
  // would observe "zero events, service alive" and propose recovery with no
  // actual signal to back it up.
  assert.ok(!calls.some((c) => c.startsWith("runAgent")));
  assert.ok(!calls.some((c) => c.startsWith("insertProposal")));
});

test("evaluateIncident: skips when project no longer exists", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls, project: null });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });
  const result = await evaluateIncident(makeCandidate(), deps);
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") assert.equal(result.reason, "no_project");
  assert.ok(!calls.some((c) => c.startsWith("runAgent")));
});

test("evaluateIncident: race-condition guard when another proposal already open", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls, existingOpenProposal: true });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });
  const result = await evaluateIncident(makeCandidate(), deps);
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") assert.equal(result.reason, "race_condition");
  assert.ok(!calls.some((c) => c.startsWith("insertProposal")));
});

test("evaluateIncident: records DB row but skips Slack when no thread context", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });
  const result = await evaluateIncident(makeCandidate(), deps);
  assert.equal(result.kind, "proposed");
  assert.ok(calls.includes("insertProposal:inc-1:medium"));
  assert.ok(!calls.some((c) => c.startsWith("postProposal")));
  assert.ok(calls.includes("logger.info:no slack thread for proposal — recorded DB row only"));
});

test("evaluateIncident: does not update slack message ts when Slack post fails", async () => {
  const calls: string[] = [];
  const slack = makeSlack({ calls, ok: false });
  const repo = makeRepo({
    calls,
    slackInstallation: {
      id: "inst-1",
      botAccessToken: "xoxb-fake",
    } as schema.SlackInstallation,
  });
  const incident = makeCandidate({
    slackChannelId: "C1",
    slackThreadTs: "1.0",
    slackInstallationId: "inst-1",
  });
  const deps = makeDeps({ calls, repo, slack, proposal: makeProposal() });

  await evaluateIncident(incident, deps);
  assert.ok(calls.includes("postProposal:prop-1"));
  assert.ok(!calls.some((c) => c.startsWith("setProposalSlackMessageTs")));
  assert.ok(calls.includes("logger.warn:slack proposal post failed"));
});

test("runAutorecoveryTick: throttled when last run was recent", async () => {
  const calls: string[] = [];
  const recentRun = new Date(NOW.getTime() - 10 * 60 * 1000); // 10 minutes ago
  const repo = makeRepo({ calls, lastRun: recentRun });
  const deps = makeDeps({ calls, repo });

  const processed = await runAutorecoveryTick(deps);
  assert.equal(processed, 0);
  assert.deepEqual(calls, ["getLastRunAt"]);
});

test("runAutorecoveryTick: stamps cursor after a successful selection, before agent runs", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    lastRun: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    candidates: [makeCandidate(), makeCandidate({ id: "inc-2" })],
  });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });

  const processed = await runAutorecoveryTick(deps);
  assert.equal(processed, 2);
  // Selection runs first, so a failing query surfaces instead of silently
  // advancing the cursor; the cursor is then stamped before the agent loop.
  const idxSelect = calls.indexOf("selectCandidates:false");
  const idxStamp = calls.indexOf(`setLastRunAt:${NOW.toISOString()}`);
  const idxFirstAgent = calls.findIndex((c) => c.startsWith("runAgent"));
  assert.ok(idxSelect >= 0);
  assert.ok(idxStamp > idxSelect);
  assert.ok(idxFirstAgent > idxStamp);
});

test("runAutorecoveryTick: marks every candidate evaluated, even when the agent throws", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    lastRun: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    candidates: [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })],
  });
  const deps: TickDeps = {
    ...makeDeps({ calls, repo, proposal: makeProposal() }),
    async runAgent(incident) {
      calls.push(`runAgent:${incident.id}`);
      if (incident.id === "b") throw new Error("nope");
      return makeProposal();
    },
  };

  await runAutorecoveryTick(deps);
  // Both incidents get stamped so neither re-occupies the front of the
  // NULLS-FIRST queue next tick — including "b", whose agent threw.
  assert.ok(calls.includes(`markEvaluated:a:${NOW.toISOString()}`));
  assert.ok(calls.includes(`markEvaluated:b:${NOW.toISOString()}`));
  // Stamp happens before the agent call for that incident.
  assert.ok(calls.indexOf(`markEvaluated:b:${NOW.toISOString()}`) < calls.indexOf("runAgent:b"));
});

test("runAutorecoveryTick: a markEvaluated failure isolates to that candidate", async () => {
  const calls: string[] = [];
  const repo = makeRepo({
    calls,
    lastRun: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    candidates: [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })],
  });
  const failingRepo: AutorecoveryRepository = {
    ...repo,
    async markEvaluated(incidentId, at) {
      calls.push(`markEvaluated:${incidentId}:${at.toISOString()}`);
      if (incidentId === "a") throw new Error("stamp write failed");
    },
  };
  const deps = makeDeps({ calls, repo: failingRepo, proposal: makeProposal() });

  await runAutorecoveryTick(deps);

  // "a"'s stamp threw, but the pass continues and still processes "b" — the
  // failure is logged per-candidate rather than aborting the whole tick.
  assert.ok(calls.includes("logger.warn:autorecovery candidate failed"));
  assert.ok(!calls.includes("runAgent:a"), "a's agent is skipped after its stamp failed");
  assert.ok(calls.includes("runAgent:b"), "b is still evaluated despite a's stamp failure");
});

test("runAutorecoveryTick: a failing candidate does not block the rest", async () => {
  const calls: string[] = [];
  const candidates = [
    makeCandidate({ id: "a" }),
    makeCandidate({ id: "b" }),
    makeCandidate({ id: "c" }),
  ];
  const repo = makeRepo({
    calls,
    lastRun: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    candidates,
  });
  // Run agent throws for incident "b"
  const deps: TickDeps = {
    ...makeDeps({ calls, repo, proposal: makeProposal() }),
    async runAgent(incident) {
      calls.push(`runAgent:${incident.id}`);
      if (incident.id === "b") throw new Error("nope");
      return makeProposal();
    },
  };

  const processed = await runAutorecoveryTick(deps);
  assert.equal(processed, 2);
  assert.ok(calls.includes("logger.warn:autorecovery candidate failed"));
});

test("runAutorecoveryTick: cancellation stops before the next candidate", async () => {
  const calls: string[] = [];
  let cancelled = false;
  const repo = makeRepo({
    calls,
    lastRun: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    candidates: [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })],
  });
  const deps: TickDeps & { isCancelled: () => boolean } = {
    ...makeDeps({ calls, repo, proposal: makeProposal() }),
    isCancelled: () => cancelled,
    async runAgent(incident) {
      calls.push(`runAgent:${incident.id}`);
      cancelled = true;
      throw new Error("job deadline exceeded");
    },
  };

  await runAutorecoveryTick(deps);

  assert.ok(calls.includes("runAgent:a"));
  assert.ok(!calls.includes("runAgent:b"));
  assert.ok(!calls.includes(`markEvaluated:b:${NOW.toISOString()}`));
  assert.ok(!calls.includes("logger.warn:autorecovery candidate failed"));
});

test("runAutorecoveryNow: bypasses throttle and filters by incidentIds", async () => {
  const calls: string[] = [];
  const candidates = [
    makeCandidate({ id: "a" }),
    makeCandidate({ id: "b" }),
    makeCandidate({ id: "c" }),
  ];
  const repo = makeRepo({ calls, candidates });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });

  const out = await runAutorecoveryNow(deps, { incidentIds: ["b"] });
  assert.equal(out.candidates, 1);
  assert.equal(out.proposalsWritten, 1);
  assert.ok(calls.includes("selectCandidates:true"));
});

test("runAutorecoveryNow: a failing candidate does not abort the rest", async () => {
  const calls: string[] = [];
  const candidates = [
    makeCandidate({ id: "a" }),
    makeCandidate({ id: "b" }),
    makeCandidate({ id: "c" }),
  ];
  const repo = makeRepo({ calls, candidates });
  const deps: TickDeps = {
    ...makeDeps({ calls, repo, proposal: makeProposal() }),
    async runAgent(incident) {
      calls.push(`runAgent:${incident.id}`);
      if (incident.id === "b") throw new Error("nope");
      return makeProposal();
    },
  };

  const out = await runAutorecoveryNow(deps);
  assert.equal(out.candidates, 3);
  assert.equal(out.proposalsWritten, 2);
  assert.ok(calls.includes("logger.warn:autorecovery candidate failed"));
});

test("runAutorecoveryNow without incidentIds runs over all selected candidates", async () => {
  const calls: string[] = [];
  const candidates = [makeCandidate(), makeCandidate({ id: "inc-2" })];
  const repo = makeRepo({ calls, candidates });
  const deps = makeDeps({ calls, repo, proposal: makeProposal() });

  const out = await runAutorecoveryNow(deps);
  assert.equal(out.candidates, 2);
  assert.equal(out.proposalsWritten, 2);
  assert.ok(calls.includes("selectCandidates:false"));
});
