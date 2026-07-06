import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  type IntakeDeps,
  type IntakeLifecycle,
  type IntakeRepository,
  ensureIncidentForIssueWorkflow,
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
    async findLatestIncidentIssueLink(issueId: string) {
      opts.calls.push(`findLatestIncidentIssueLink:${issueId}`);
      return opts.existingLink as schema.IncidentIssue | undefined;
    },
    async touchIncidentLastSeen(incidentId: string, _lastSeen: Date) {
      opts.calls.push(`touchIncidentLastSeen:${incidentId}`);
    },
    async findIncident(incidentId) {
      opts.calls.push(`findIncident:${incidentId}`);
      return incidentById.get(incidentId);
    },
    async findOpenIncidentCandidates(_issue, queryOpts) {
      opts.calls.push(`findOpenIncidentCandidates:${queryOpts.filterService}`);
      return queryOpts.filterService
        ? (opts.openCandidates?.withService ?? [])
        : (opts.openCandidates?.withoutService ?? []);
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
  recurrenceIncident?: schema.Incident;
  createdIncident?: schema.Incident;
}): IntakeLifecycle {
  return {
    async openRecurrence(input) {
      opts.calls.push(`openRecurrence:${input.previousIncident.id}<-${input.issue.id}:${input.origin}`);
      return (
        opts.recurrenceIncident ??
        makeIncident({
          id: "inc-recurrence",
          previousIncidentId: input.previousIncident.id,
        })
      );
    },
    async createOpen(input) {
      opts.calls.push(
        `createOpen:${input.projectId}:${input.title}:env=${input.environment ?? ""}`,
      );
      return (
        opts.createdIncident ??
        makeIncident({ id: "inc-new", title: input.title, environment: input.environment ?? null })
      );
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
      overrides.analyzeGrouping ?? (async () => ({ decision: "standalone", evidence: null })),
    logger: {
      warn(_obj, msg) {
        overrides.calls.push(`logger.warn:${msg ?? ""}`);
      },
    },
  };
}

test("intake: existing link touches the open incident and returns it unchanged", async () => {
  const calls: string[] = [];
  const existing = makeIncident({ id: "inc-old" });
  const repo = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-old" },
    incidentById: new Map([["inc-old", existing]]),
  });
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    "new",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.linkedIssue, false);
  assert.equal(result.recurrenceIncident, false);
  assert.equal(result.incident.id, "inc-old");
  assert.ok(calls.includes("touchIncidentLastSeen:inc-old"));
});

test("intake: recurred issue opens a new incident chained to its previous one", async () => {
  const calls: string[] = [];
  const previous = makeIncident({ id: "inc-prev", status: "resolved" });
  const repo = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-prev" },
    incidentById: new Map([["inc-prev", previous]]),
  });
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ status: "resolved" } as Partial<schema.Issue>),
    "recurred",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, true);
  assert.equal(result.recurrenceIncident, true);
  assert.equal(result.incident.id, "inc-recurrence");
  assert.equal(result.incident.previousIncidentId, "inc-prev");
  assert.ok(calls.includes("openRecurrence:inc-prev<-iss-new:resolved_issue_recurred"));
  assert.ok(
    calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:standalone:heuristic:Recurrence")),
  );
});

test("intake: recurred issue whose latest link is already open reuses it (retry idempotency)", async () => {
  const calls: string[] = [];
  const alreadyOpen = makeIncident({ id: "inc-open", status: "open" });
  const repo = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-open" },
    incidentById: new Map([["inc-open", alreadyOpen]]),
  });
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    "recurred",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.recurrenceIncident, false);
  assert.equal(result.incident.id, "inc-open");
  assert.ok(!calls.some((c) => c.startsWith("openRecurrence:")));
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
    "new",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.linkedIssue, true);
  assert.equal(result.incident.id, "inc-match");
  assert.ok(calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:grouped:heuristic")));
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
    "new",
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

test("intake: fresh incident captures environment from the issue's resource attrs", async () => {
  const calls: string[] = [];
  const repo = makeRepo({ calls });
  const lifecycle = makeLifecycle({ calls });
  const issue = makeIssue({
    kind: "alert",
    lastSample: {
      kind: "span",
      service: "api",
      severity: null,
      message: null,
      body: null,
      exceptionType: "ECONNREFUSED",
      topFrame: null,
      normalizedFrames: [],
      stacktrace: null,
      seenAt: NOW.toISOString(),
      resourceAttrs: { "deployment.environment.name": "production" },
    },
  });
  const result = await ensureIncidentForIssueWorkflow(
    issue,
    "new",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, true);
  assert.equal(result.incident.environment, "production");
  assert.ok(calls.some((c) => c.startsWith("createOpen:proj-1:") && c.endsWith(":env=production")));
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
    "new",
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
  assert.ok(calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:grouped:llm")));
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
    "new",
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
    "new",
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
