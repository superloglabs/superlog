import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  ensureIncidentForIssueWorkflow,
  type IntakeDeps,
  type IntakeLifecycle,
  type IntakeRepository,
} from "./intake.js";

const NOW = new Date("2026-05-23T10:00:00Z");

function makeIssue(overrides: Partial<schema.Issue> = {}): schema.Issue {
  return {
    id: "iss-new",
    projectId: "proj-1",
    fingerprint: "fp",
    kind: "span",
    service: "api",
    exceptionType: "ECONNREFUSED",
    title: "ECONNREFUSED to db",
    message: "conn refused",
    topFrame: "db.query",
    normalizedFrames: ["db.query"],
    lastSample: null,
    firstSeen: NOW,
    lastSeen: NOW,
    eventCount: 1,
    groupingState: "pending",
    groupingSource: null,
    groupingReason: null,
    groupingAttemptedAt: null,
    groupingAttemptCount: 0,
    silencedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as schema.Issue;
}

function makeIncident(overrides: Partial<schema.Incident> = {}): schema.Incident {
  return {
    id: "inc-1",
    projectId: "proj-1",
    title: "DB unreachable",
    status: "open",
    service: "api",
    codename: "purple-otter",
    firstSeen: NOW,
    lastSeen: NOW,
    issueCount: 1,
    ...overrides,
  } as unknown as schema.Incident;
}

function makeRepo(opts: {
  calls: string[];
  existingLink?: { issueId: string; incidentId: string } | undefined;
  incidentById?: Map<string, schema.Incident>;
  openCandidates?: { withService: schema.Incident[]; withoutService: schema.Incident[] };
  project?: schema.Project;
  linkInsertsSuccess?: boolean;
}): IntakeRepository {
  const incidentById = opts.incidentById ?? new Map<string, schema.Incident>();
  return {
    async findIncidentIssueLink(issueId) {
      opts.calls.push(`findIncidentIssueLink:${issueId}`);
      return opts.existingLink as schema.IncidentIssue | undefined;
    },
    async findIncident(incidentId) {
      opts.calls.push(`findIncident:${incidentId}`);
      return incidentById.get(incidentId);
    },
    async findOpenIncidentCandidates(_issue, queryOpts) {
      opts.calls.push(`findOpenIncidentCandidates:${queryOpts.filterService}`);
      return queryOpts.filterService
        ? opts.openCandidates?.withService ?? []
        : opts.openCandidates?.withoutService ?? [];
    },
    async loadLinkedIncidentIssues(incidents) {
      opts.calls.push(`loadLinkedIncidentIssues:${incidents.length}`);
      return [];
    },
    async findProject(projectId) {
      opts.calls.push(`findProject:${projectId}`);
      return opts.project;
    },
    async linkIssueToIncident(input) {
      opts.calls.push(`linkIssueToIncident:${input.issue.id}->${input.incident.id}`);
      return opts.linkInsertsSuccess ?? true;
    },
    async updateIssueGrouping(issueId, input) {
      opts.calls.push(
        `updateIssueGrouping:${issueId}:${input.state}:${input.source ?? ""}:${input.reason ?? ""}`,
      );
    },
  };
}

function makeLifecycle(opts: {
  calls: string[];
  reopened?: boolean;
  createdIncident?: schema.Incident;
}): IntakeLifecycle {
  return {
    async reopenFromIssueRegression(input) {
      opts.calls.push(`reopen:${input.incident.id}<-${input.issue.id}`);
      return { reopened: opts.reopened ?? false };
    },
    async createOpen(input) {
      opts.calls.push(`createOpen:${input.projectId}:${input.title}`);
      return opts.createdIncident ?? makeIncident({ id: "inc-new", title: input.title });
    },
  };
}

function makeDeps(overrides: {
  repo: IntakeRepository;
  lifecycle: IntakeLifecycle;
  analyzeGrouping?: IntakeDeps["analyzeGrouping"];
  calls: string[];
}): IntakeDeps {
  return {
    repo: overrides.repo,
    lifecycle: overrides.lifecycle,
    analyzeGrouping:
      overrides.analyzeGrouping ??
      (async () => ({ decision: "standalone", evidence: null })),
    logger: {
      warn(_obj, msg) {
        overrides.calls.push(`logger.warn:${msg ?? ""}`);
      },
    },
  };
}

test("intake: existing link reopens incident and returns it unchanged", async () => {
  const calls: string[] = [];
  const existing = makeIncident({ id: "inc-old" });
  const repo = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-old" },
    incidentById: new Map([["inc-old", existing]]),
  });
  const lifecycle = makeLifecycle({ calls, reopened: true });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.linkedIssue, false);
  assert.equal(result.reopenedIncident, true);
  assert.equal(result.incident.id, "inc-old");
  assert.ok(calls.includes("reopen:inc-old<-iss-new"));
});

test("intake: heuristic match links to existing incident as 'grouped'", async () => {
  const calls: string[] = [];
  const existing = makeIncident({
    id: "inc-match",
    title: "ECONNREFUSED to db",
    issueCount: 1,
  });
  const repo = makeRepo({
    calls,
    openCandidates: { withService: [existing], withoutService: [] },
    incidentById: new Map([["inc-match", existing]]),
  });
  // Heuristic match requires >=2 overlapping normalized frames.
  repo.loadLinkedIncidentIssues = async () => [
    {
      incidentId: "inc-match",
      title: existing.title,
      exceptionType: "ECONNREFUSED",
      message: null,
      topFrame: "db.query",
      normalizedFrames: ["db.query", "pool.acquire", "handler.process"],
      lastSample: null,
      lastSeen: NOW,
    },
  ];
  const lifecycle = makeLifecycle({ calls });
  const issue = makeIssue({
    normalizedFrames: ["db.query", "pool.acquire", "handler.process"],
  });
  const result = await ensureIncidentForIssueWorkflow(
    issue,
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.linkedIssue, true);
  assert.equal(result.incident.id, "inc-match");
  assert.ok(
    calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:grouped:heuristic")),
  );
});

test("intake: alert issue with no heuristic match opens fresh incident, skips LLM", async () => {
  const calls: string[] = [];
  const newInc = makeIncident({ id: "inc-fresh" });
  const repo = makeRepo({
    calls,
    incidentById: new Map([["inc-fresh", newInc]]),
  });
  const lifecycle = makeLifecycle({ calls, createdIncident: newInc });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert" }),
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, true);
  assert.equal(result.incident.id, "inc-fresh");
  // No LLM grouping pending update.
  assert.ok(!calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:pending")));
  // Standalone with heuristic source (LLM skipped for alerts).
  assert.ok(
    calls.some((c) =>
      c.startsWith(
        "updateIssueGrouping:iss-new:standalone:heuristic:Alert issues are not LLM-grouped",
      ),
    ),
  );
});

test("intake: LLM 'join' verdict links to the chosen incident", async () => {
  const calls: string[] = [];
  const candidate = makeIncident({
    id: "inc-llm",
    title: "Different surface, same root cause",
    issueCount: 2,
  });
  const repo = makeRepo({
    calls,
    openCandidates: { withService: [], withoutService: [candidate] },
    incidentById: new Map([["inc-llm", candidate]]),
    project: {
      id: "proj-1",
      orgId: "org-1",
      name: "Proj",
    } as schema.Project,
  });
  // Provide linked issue context so buildGroupingCandidate yields a usable candidate.
  repo.loadLinkedIncidentIssues = async (incidents) => {
    calls.push(`loadLinkedIncidentIssues:${incidents.length}`);
    return incidents.map((incident) => ({
      incidentId: incident.id,
      title: incident.title,
      exceptionType: "ECONNREFUSED",
      message: "conn refused",
      topFrame: "db.query",
      normalizedFrames: ["db.query"],
      lastSample: null,
      lastSeen: incident.lastSeen,
    }));
  };
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    makeDeps({
      repo,
      lifecycle,
      calls,
      async analyzeGrouping(input) {
        calls.push(`analyzeGrouping:${input.candidates.length}`);
        return {
          decision: "join",
          incidentId: "inc-llm",
          evidence: "matching upstream dependency in stack",
        };
      },
    }),
  );
  assert.equal(result.incident.id, "inc-llm");
  assert.ok(calls.includes("updateIssueGrouping:iss-new:pending:llm:Waiting for LLM grouping."));
  assert.ok(
    calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:grouped:llm")),
  );
});

test("intake: LLM 'join' verdict with unknown id falls back to standalone (and opens new incident)", async () => {
  const calls: string[] = [];
  const candidate = makeIncident({
    id: "inc-existing",
    issueCount: 1,
  });
  const newInc = makeIncident({ id: "inc-fresh", title: "ECONNREFUSED to db" });
  const repo = makeRepo({
    calls,
    openCandidates: { withService: [], withoutService: [candidate] },
    incidentById: new Map([
      ["inc-existing", candidate],
      ["inc-fresh", newInc],
    ]),
  });
  repo.loadLinkedIncidentIssues = async (incidents) =>
    incidents.map((incident) => ({
      incidentId: incident.id,
      title: incident.title,
      exceptionType: "ECONNREFUSED",
      message: "conn refused",
      topFrame: "db.query",
      normalizedFrames: ["db.query"],
      lastSample: null,
      lastSeen: incident.lastSeen,
    }));
  const lifecycle = makeLifecycle({ calls, createdIncident: newInc });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    makeDeps({
      repo,
      lifecycle,
      calls,
      async analyzeGrouping() {
        return { decision: "join", incidentId: "ghost", evidence: "x".repeat(30) };
      },
    }),
  );
  assert.equal(result.createdIncident, true);
  assert.ok(
    calls.some((c) =>
      c.startsWith("updateIssueGrouping:iss-new:standalone:llm:LLM selected an unknown incident."),
    ),
  );
});

test("intake: LLM error logs a warning and marks issue 'failed'", async () => {
  const calls: string[] = [];
  const candidate = makeIncident({ id: "inc-x", issueCount: 1 });
  const newInc = makeIncident({ id: "inc-fresh" });
  const repo = makeRepo({
    calls,
    openCandidates: { withService: [], withoutService: [candidate] },
    incidentById: new Map([["inc-fresh", newInc]]),
  });
  repo.loadLinkedIncidentIssues = async (incidents) =>
    incidents.map((incident) => ({
      incidentId: incident.id,
      title: incident.title,
      exceptionType: "ECONNREFUSED",
      message: "conn refused",
      topFrame: "db.query",
      normalizedFrames: ["db.query"],
      lastSample: null,
      lastSeen: incident.lastSeen,
    }));
  const lifecycle = makeLifecycle({ calls, createdIncident: newInc });
  await ensureIncidentForIssueWorkflow(
    makeIssue(),
    makeDeps({
      repo,
      lifecycle,
      calls,
      async analyzeGrouping() {
        throw new Error("anthropic 500");
      },
    }),
  );
  assert.ok(calls.includes("logger.warn:llm grouping failed"));
  assert.ok(
    calls.some((c) =>
      c.startsWith("updateIssueGrouping:iss-new:failed:llm:LLM grouping failed: anthropic 500"),
    ),
  );
});
