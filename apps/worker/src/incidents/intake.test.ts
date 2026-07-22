import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { schema } from "@superlog/db";
import { type GroupingLLMClient, runGroupingAgent } from "../grouping/agent.js";
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
  linkOutcomes?: Array<"linked" | "already_linked" | "incident_closed">;
  alertEpisode?: schema.AlertEpisode;
  openIncidentForAlert?: schema.Incident;
  latestIncidentForAlert?: schema.Incident;
}): IntakeRepository {
  const incidentById = opts.incidentById ?? new Map<string, schema.Incident>();
  return {
    async findLatestIncidentIssueLink(issueId: string) {
      opts.calls.push(`findLatestIncidentIssueLink:${issueId}`);
      return opts.existingLink as schema.IncidentIssue | undefined;
    },
    async findAlertEpisodeForIssue(issueId: string) {
      opts.calls.push(`findAlertEpisodeForIssue:${issueId}`);
      return opts.alertEpisode;
    },
    async findOpenIncidentForAlert(alertId: string, groupKey: string) {
      opts.calls.push(`findOpenIncidentForAlert:${alertId}:${groupKey || "*"}`);
      return opts.openIncidentForAlert;
    },
    async findLatestIncidentForAlert(alertId: string, groupKey: string) {
      opts.calls.push(`findLatestIncidentForAlert:${alertId}:${groupKey || "*"}`);
      return opts.latestIncidentForAlert;
    },
    async touchIncidentLastSeen(incidentId: string, _lastSeen: Date) {
      opts.calls.push(`touchIncidentLastSeen:${incidentId}`);
    },
    async findIncident(incidentId) {
      opts.calls.push(`findIncident:${incidentId}`);
      return incidentById.get(incidentId);
    },
    async findOpenRecurrenceForIncident(previousIncidentId) {
      opts.calls.push(`findOpenRecurrenceForIncident:${previousIncidentId}`);
      return undefined;
    },
    async reopenIssue(issueId) {
      opts.calls.push(`reopenIssue:${issueId}`);
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
      return opts.linkOutcomes?.shift() ?? "linked";
    },
    async updateIssueGrouping(issueId, input) {
      opts.calls.push(
        `updateIssueGrouping${input.onlyIfPending ? "(pending-only)" : input.onlyIfUndecided ? "(undecided-only)" : ""}:${issueId}:${input.state}:${input.source ?? ""}:${input.reason ?? ""}`,
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
      opts.calls.push(
        `openRecurrence:${input.previousIncident.id}<-${input.issue.id}:${input.origin}`,
      );
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
  serializeCreate?: IntakeDeps["serializeCreate"];
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
      error(_obj, msg) {
        overrides.calls.push(`logger.error:${msg ?? ""}`);
      },
    },
    serializeCreate: overrides.serializeCreate,
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

test("intake: preferred open incident is validated and joined before grouping", async () => {
  const calls: string[] = [];
  const preferred = makeIncident({ id: "inc-preferred", projectId: "proj-1", status: "open" });
  const repo = makeRepo({
    calls,
    incidentById: new Map([[preferred.id, preferred]]),
  });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    "new",
    makeDeps({ repo, lifecycle: makeLifecycle({ calls }), calls }),
    {
      preferredOpenIncidentId: preferred.id,
      preferredMatchReason: "The scheduled scan found the same metric anomaly.",
    },
  );

  assert.equal(result.createdIncident, false);
  assert.equal(result.linkedIssue, true);
  assert.equal(result.incident.id, preferred.id);
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-preferred"));
  assert.ok(
    calls.includes(
      "updateIssueGrouping:iss-new:grouped:llm:The scheduled scan found the same metric anomaly.",
    ),
  );
  assert.ok(!calls.some((call) => call.startsWith("findOpenIncidentCandidates:")));
  assert.ok(!calls.some((call) => call.startsWith("createOpen:")));
});

test("intake: stale preferred incident falls through to normal grouping", async () => {
  const calls: string[] = [];
  const closed = makeIncident({ id: "inc-closed", status: "resolved" });
  const repo = makeRepo({
    calls,
    incidentById: new Map([[closed.id, closed]]),
  });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue(),
    "new",
    makeDeps({ repo, lifecycle: makeLifecycle({ calls }), calls }),
    {
      preferredOpenIncidentId: closed.id,
      preferredMatchReason: "This must not be trusted after the incident closes.",
    },
  );

  assert.equal(result.createdIncident, true);
  assert.equal(result.incident.id, "inc-new");
  assert.ok(calls.some((call) => call.startsWith("findOpenIncidentCandidates:")));
  assert.ok(calls.some((call) => call.startsWith("createOpen:")));
  assert.ok(!calls.includes("linkIssueToIncident:iss-new->inc-closed"));
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
    calls.some((c) =>
      c.startsWith(
        "updateIssueGrouping:iss-new:standalone:heuristic:No open incidents in this project.",
      ),
    ),
  );
});

test("intake: recurred issue goes through grouping and joins an existing incident", async () => {
  const calls: string[] = [];
  const previous = makeIncident({ id: "inc-prev", status: "resolved" });
  const candidate = makeIncident({ id: "inc-current", title: "Recall credits exhausted" });
  const repo = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-prev" },
    incidentById: new Map([
      ["inc-prev", previous],
      ["inc-current", candidate],
    ]),
    openCandidates: { withService: [], withoutService: [candidate] },
    project: { id: "proj-1", orgId: "org-1", name: "Production" } as schema.Project,
  });
  repo.loadLinkedIncidentIssues = async (incidents) =>
    incidents.map((incident) => ({
      incidentId: incident.id,
      issueId: "iss-linked",
      service: null,
      title: incident.title,
      exceptionType: "ERROR",
      message: "Recall.ai returned insufficient_credit_balance",
      topFrame: null,
      normalizedFrames: [],
      lastSample: null,
      lastSeen: NOW,
    }));

  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({
      kind: "log",
      status: "resolved",
      normalizedFrames: [],
      lastSample: null,
    } as Partial<schema.Issue>),
    "recurred",
    makeDeps({
      repo,
      lifecycle: makeLifecycle({ calls }),
      calls,
      analyzeGrouping: async () => {
        calls.push("analyzeGrouping");
        return {
          decision: "join",
          incidentId: "inc-current",
          evidence: "Both failures come from the same exhausted Recall.ai credit balance.",
        };
      },
    }),
  );

  assert.equal(result.createdIncident, false);
  assert.equal(result.recurrenceIncident, false);
  assert.equal(result.incident.id, "inc-current");
  assert.ok(calls.includes("analyzeGrouping"));
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-current"));
  assert.ok(calls.includes("reopenIssue:iss-new"));
  assert.ok(!calls.some((call) => call.startsWith("openRecurrence:")));
});

test("intake: recurred same-trace sibling joins the incident instead of opening a recurrence", async () => {
  // Same request, resolved yesterday, recurring now: the span exception's
  // incident is (re)opened by a racing transition; this log symptom shares the
  // trace and must join it, not chain its own recurrence to its own predecessor.
  const calls: string[] = [];
  const previous = makeIncident({ id: "inc-prev", status: "resolved" });
  const sibling = makeIncident({ id: "inc-sibling", service: "superlog-sample-nextjs" });
  const base = makeRepo({
    calls,
    existingLink: { issueId: "iss-log", incidentId: "inc-prev" },
    incidentById: new Map([
      ["inc-prev", previous],
      ["inc-sibling", sibling],
    ]),
  });
  const repo: IntakeRepository = {
    ...base,
    async findOpenIncidentCandidates(_issue, queryOpts) {
      calls.push(`findOpenIncidentCandidates:${queryOpts.filterService}`);
      return queryOpts.filterService ? [] : [sibling];
    },
    async loadLinkedIncidentIssues(incidents) {
      calls.push(`loadLinkedIncidentIssues:${incidents.length}`);
      return incidents.map((inc) => ({
        incidentId: inc.id,
        title: "span exception",
        exceptionType: "TypeError",
        message: null,
        topFrame: null,
        normalizedFrames: [],
        lastSample: { traceId: "trace-1", spanId: "span-exc" },
        lastSeen: NOW,
      })) as unknown as Awaited<ReturnType<IntakeRepository["loadLinkedIncidentIssues"]>>;
    },
  };
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({
      id: "iss-log",
      service: "superlog-sample",
      status: "resolved",
      lastSample: { traceId: "trace-1", spanId: "span-log" },
    } as Partial<schema.Issue>),
    "recurred",
    makeDeps({
      repo,
      lifecycle: makeLifecycle({ calls }),
      calls,
      serializeCreate: async (keys, fn) => {
        calls.push(`serializeCreate:${String(keys)}`);
        return fn();
      },
    }),
  );

  assert.equal(result.createdIncident, false);
  assert.equal(result.recurrenceIncident, false);
  assert.equal(result.incident.id, "inc-sibling");
  assert.ok(calls.includes("serializeCreate:recurrence:inc-prev,trace:trace-1"));
  assert.ok(calls.includes("linkIssueToIncident:iss-log->inc-sibling"));
  assert.ok(!calls.some((c) => c.startsWith("openRecurrence")));
});

test("intake: recurred no-trace issue re-lands on a recurrence a racer opened inside the lock", async () => {
  // Outside the lock the previous incident is still resolved; by the time we
  // hold the predecessor-keyed lock a concurrent recurrence job has opened it.
  // We must re-read and re-land, not open a second.
  const calls: string[] = [];
  const resolved = makeIncident({ id: "inc-prev", status: "resolved" });
  const openedByRacer = makeIncident({ id: "inc-prev", status: "open" });
  let findIncidentCalls = 0;
  const base = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-prev" },
  });
  const repo: IntakeRepository = {
    ...base,
    async findIncident(incidentId) {
      calls.push(`findIncident:${incidentId}`);
      findIncidentCalls += 1;
      return findIncidentCalls === 1 ? resolved : openedByRacer;
    },
  };
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ status: "resolved" } as Partial<schema.Issue>),
    "recurred",
    makeDeps({ repo, lifecycle: makeLifecycle({ calls }), calls }),
  );

  assert.equal(result.createdIncident, false);
  assert.equal(result.recurrenceIncident, false);
  assert.equal(result.incident.id, "inc-prev");
  assert.ok(!calls.some((c) => c.startsWith("openRecurrence")));
});

test("intake: no-trace recurrences from the same predecessor converge on one incident", async () => {
  const calls: string[] = [];
  const previous = makeIncident({ id: "inc-prev", status: "resolved" });
  const siblingRecurrence = makeIncident({
    id: "inc-sibling-recurrence",
    previousIncidentId: "inc-prev",
  });
  const base = makeRepo({
    calls,
    existingLink: { issueId: "iss-new", incidentId: "inc-prev" },
    incidentById: new Map([
      ["inc-prev", previous],
      ["inc-sibling-recurrence", siblingRecurrence],
    ]),
  });
  const repo = {
    ...base,
    async findOpenRecurrenceForIncident(previousIncidentId: string) {
      calls.push(`findOpenRecurrenceForIncident:${previousIncidentId}`);
      return siblingRecurrence;
    },
  } as IntakeRepository;

  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({
      id: "iss-new",
      kind: "log",
      status: "resolved",
      normalizedFrames: [],
      lastSample: null,
    } as Partial<schema.Issue>),
    "recurred",
    makeDeps({
      repo,
      lifecycle: makeLifecycle({ calls }),
      calls,
      serializeCreate: async (key, fn) => {
        calls.push(`serializeCreate:${key}`);
        return fn();
      },
    }),
  );

  assert.equal(result.createdIncident, false);
  assert.equal(result.recurrenceIncident, false);
  assert.equal(result.incident.id, "inc-sibling-recurrence");
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-sibling-recurrence"));
  assert.ok(!calls.some((call) => call.startsWith("openRecurrence:")));
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
      issueId: "iss-linked",
      service: null,
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

function makeEpisode(overrides: Partial<schema.AlertEpisode> = {}): schema.AlertEpisode {
  return {
    id: "ep-1",
    alertId: "alert-1",
    projectId: "proj-1",
    groupKey: "",
    state: "firing",
    startedAt: NOW,
    endedAt: null,
    openObservedValue: 15,
    peakObservedValue: 15,
    lastObservedValue: 15,
    lastFiringAt: NOW,
    issueId: "iss-new",
    incidentId: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as schema.AlertEpisode;
}

test("intake: alert episode joins the open incident already driven by the same alert", async () => {
  const calls: string[] = [];
  const open = makeIncident({ id: "inc-same-alert" });
  const repo = makeRepo({
    calls,
    alertEpisode: makeEpisode(),
    openIncidentForAlert: open,
    incidentById: new Map([["inc-same-alert", open]]),
  });
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert" }),
    "new",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.linkedIssue, true);
  assert.equal(result.incident.id, "inc-same-alert");
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-same-alert"));
  assert.ok(
    calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:grouped:heuristic:New episode")),
  );
  // No fresh incident, no recurrence, no LLM.
  assert.ok(!calls.some((c) => c.startsWith("createOpen")));
  assert.ok(!calls.some((c) => c.startsWith("openRecurrence")));
  assert.ok(!calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:pending")));
});

test("intake: a candidate that closes while linking is regrouped from fresh state", async () => {
  const calls: string[] = [];
  const stale = makeIncident({ id: "inc-stale" });
  const base = makeRepo({
    calls,
    alertEpisode: makeEpisode(),
    linkOutcomes: ["incident_closed", "linked"],
  });
  let alertLookupCount = 0;
  const repo: IntakeRepository = {
    ...base,
    async findOpenIncidentForAlert(alertId, groupKey) {
      calls.push(`findOpenIncidentForAlert:${alertId}:${groupKey || "*"}`);
      alertLookupCount += 1;
      return alertLookupCount === 1 ? stale : undefined;
    },
  };

  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert" }),
    "new",
    makeDeps({ repo, lifecycle: makeLifecycle({ calls }), calls }),
  );

  assert.equal(result.incident.id, "inc-new");
  assert.equal(result.createdIncident, true);
  assert.equal(result.linkedIssue, true);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("linkIssueToIncident:")),
    ["linkIssueToIncident:iss-new->inc-stale", "linkIssueToIncident:iss-new->inc-new"],
  );
});

test("intake: alert episode whose previous incident is closed opens a chained recurrence", async () => {
  const calls: string[] = [];
  const previous = makeIncident({ id: "inc-prev-alert", status: "resolved" });
  const repo = makeRepo({
    calls,
    alertEpisode: makeEpisode(),
    latestIncidentForAlert: previous,
  });
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert", normalizedFrames: [] }),
    "new",
    makeDeps({ repo, lifecycle, calls }),
  );
  assert.equal(result.createdIncident, true);
  assert.equal(result.recurrenceIncident, true);
  assert.ok(calls.includes("openRecurrence:inc-prev-alert<-iss-new:alert_breached_again"));
  assert.ok(
    calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:standalone:heuristic:New breach")),
  );
});

test("intake: alert episode chaining follows a merge chain to the surviving incident", async () => {
  const calls: string[] = [];
  const survivor = makeIncident({ id: "inc-survivor", status: "open" });
  const merged = makeIncident({
    id: "inc-merged",
    status: "merged",
    mergedIntoId: "inc-survivor",
  } as Partial<schema.Incident>);
  const repo = makeRepo({
    calls,
    alertEpisode: makeEpisode(),
    latestIncidentForAlert: merged,
    incidentById: new Map([
      ["inc-survivor", survivor],
      ["inc-merged", merged],
    ]),
  });
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert" }),
    "new",
    makeDeps({ repo, lifecycle, calls }),
  );
  // The merge survivor is open → the new episode joins it instead of chaining.
  assert.equal(result.createdIncident, false);
  assert.equal(result.incident.id, "inc-survivor");
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-survivor"));
});

test("intake: create/link section runs under serializeCreate, with grouping analysis outside it", async () => {
  const calls: string[] = [];
  const newInc = makeIncident({ id: "inc-fresh" });
  const unrelated = makeIncident({ id: "inc-unrelated" });
  const repo = makeRepo({
    calls,
    incidentById: new Map([["inc-fresh", newInc]]),
    // An open candidate so the LLM grouping path actually runs.
    openCandidates: { withService: [], withoutService: [unrelated] },
  });
  repo.loadLinkedIncidentIssues = async () => [
    {
      incidentId: "inc-unrelated",
      issueId: "iss-linked",
      service: null,
      title: "something else",
      exceptionType: "Error",
      message: null,
      topFrame: null,
      normalizedFrames: [],
      lastSample: null,
      lastSeen: NOW,
    },
  ];
  const lifecycle = makeLifecycle({ calls, createdIncident: newInc });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert", normalizedFrames: [] }),
    "new",
    makeDeps({
      repo,
      lifecycle,
      calls,
      analyzeGrouping: async () => {
        calls.push("analyzeGrouping");
        return { decision: "standalone", evidence: null };
      },
      serializeCreate: async (issueId, fn) => {
        calls.push(`serializeCreate:${issueId}`);
        return fn();
      },
    }),
  );
  assert.equal(result.createdIncident, true);
  // The (potentially slow) grouping analysis must complete before the hook —
  // never inside it, where implementations hold a database connection.
  const analyze = calls.indexOf("analyzeGrouping");
  const serialize = calls.indexOf("serializeCreate:iss-new");
  const create = calls.findIndex((c) => c.startsWith("createOpen"));
  assert.ok(analyze !== -1 && serialize !== -1 && create !== -1);
  assert.ok(analyze < serialize);
  assert.ok(serialize < create);
});

test("intake: serialized create re-checks the link and re-lands on a racer's incident", async () => {
  const calls: string[] = [];
  const racerIncident = makeIncident({ id: "inc-racer" });
  const repo = makeRepo({ calls, incidentById: new Map([["inc-racer", racerIncident]]) });
  // No link when intake starts; the racer's link appears by the time the
  // serialized section runs (the racer held the lock first).
  let linkCalls = 0;
  repo.findLatestIncidentIssueLink = async (issueId) => {
    calls.push(`findLatestIncidentIssueLink:${issueId}`);
    linkCalls += 1;
    if (linkCalls === 1) return undefined;
    return { issueId, incidentId: "inc-racer" } as schema.IncidentIssue;
  };
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert", normalizedFrames: [] }),
    "new",
    makeDeps({
      repo,
      lifecycle,
      calls,
      serializeCreate: async (_issueId, fn) => fn(),
    }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.incident.id, "inc-racer");
  assert.ok(!calls.some((c) => c.startsWith("createOpen")));
  assert.ok(!calls.some((c) => c.startsWith("openRecurrence")));
  // The loser clears only its own in-flight 'pending' marker (pending-only,
  // so the winner's recorded verdict is never clobbered) and records *its own*
  // grouping result — here standalone/heuristic (no open candidates) — rather
  // than a hard-coded 'grouped/heuristic' that would mislabel the issue.
  assert.ok(
    calls.some((c) =>
      c.startsWith(
        "updateIssueGrouping(pending-only):iss-new:standalone:heuristic:No open incidents",
      ),
    ),
  );
  assert.ok(
    !calls.some((c) => c.startsWith("updateIssueGrouping(pending-only):iss-new:grouped:heuristic")),
  );
});

test("intake: first-ever alert episode goes through LLM grouping like an error", async () => {
  const calls: string[] = [];
  const errorIncident = makeIncident({ id: "inc-error", title: "DB down" });
  const repo = makeRepo({
    calls,
    alertEpisode: makeEpisode(),
    openCandidates: { withService: [], withoutService: [errorIncident] },
    incidentById: new Map([["inc-error", errorIncident]]),
  });
  repo.loadLinkedIncidentIssues = async () => [
    {
      incidentId: "inc-error",
      issueId: "iss-linked",
      service: null,
      title: "DB down",
      exceptionType: "ECONNREFUSED",
      message: null,
      topFrame: "db.query",
      normalizedFrames: ["db.query", "pool.acquire"],
      lastSample: null,
      lastSeen: NOW,
    },
  ];
  const lifecycle = makeLifecycle({ calls });
  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({ kind: "alert", normalizedFrames: [] }),
    "new",
    makeDeps({
      repo,
      lifecycle,
      calls,
      analyzeGrouping: async () => ({
        decision: "join",
        incidentId: "inc-error",
        evidence: "same root cause",
      }),
    }),
  );
  assert.equal(result.createdIncident, false);
  assert.equal(result.incident.id, "inc-error");
  assert.ok(
    calls.some((c) => c.startsWith("updateIssueGrouping(undecided-only):iss-new:pending:llm")),
  );
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-error"));
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
      issueId: "iss-linked",
      service: null,
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
  assert.ok(
    calls.includes(
      "updateIssueGrouping(undecided-only):iss-new:pending:llm:Waiting for LLM grouping.",
    ),
  );
  assert.ok(calls.some((c) => c.startsWith("updateIssueGrouping:iss-new:grouped:llm")));
});

test("intake replay: oversized related bundler errors reuse one incident", async () => {
  const calls: string[] = [];
  const headline = 'Failed to resolve import "./missing.png" from "app/cart.tsx"';
  const oversizedMessage = `${headline}\nPlugin: vite:import-analysis\n${"generatedCall();".repeat(
    40_000,
  )}\nat normalizeUrl`;
  const candidate = makeIncident({
    id: "inc-existing",
    title: headline,
    service: "web",
    issueCount: 1,
  });
  const repo = makeRepo({
    calls,
    openCandidates: { withService: [], withoutService: [candidate] },
    incidentById: new Map([[candidate.id, candidate]]),
    project: { id: "proj-1", orgId: "org-1", name: "Production" } as schema.Project,
  });
  repo.loadLinkedIncidentIssues = async () => [
    {
      incidentId: candidate.id,
      issueId: "iss-existing",
      service: "web",
      title: headline,
      exceptionType: "Error",
      message: oversizedMessage,
      topFrame: "normalizeUrl",
      normalizedFrames: ["normalizeUrl"],
      lastSample: null,
      lastSeen: NOW,
    },
  ];
  const requestChars: number[] = [];
  let turn = 0;
  const client: GroupingLLMClient = {
    async send(input) {
      requestChars.push(JSON.stringify(input.messages).length);
      turn += 1;
      const content =
        turn === 1
          ? [
              {
                type: "tool_use",
                id: "inspect",
                name: "inspect_incident",
                input: { incident_id: candidate.id },
              },
            ]
          : [
              {
                type: "tool_use",
                id: "decide",
                name: "decide_grouping",
                input: {
                  decision: "join",
                  incidentId: candidate.id,
                  evidence: "both failures are the same unresolved asset import in the same module",
                },
              },
            ];
      return {
        content,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as Anthropic.Messages.Message;
    },
  };

  const result = await ensureIncidentForIssueWorkflow(
    makeIssue({
      service: "web",
      exceptionType: "Error",
      title: headline,
      message: oversizedMessage,
      topFrame: "normalizeUrl",
      normalizedFrames: [],
    }),
    "new",
    makeDeps({
      repo,
      lifecycle: makeLifecycle({ calls }),
      calls,
      async analyzeGrouping(input) {
        assert.ok((input.newIssue.message?.length ?? 0) <= 12_000);
        return runGroupingAgent(
          {
            projectName: input.projectName,
            newIssue: input.newIssue,
            candidates: input.candidates,
          },
          {
            client,
            model: "test-model",
            maxIterations: 3,
            accountant: { record() {} },
          },
        );
      },
    }),
  );

  assert.ok(oversizedMessage.length > 600_000);
  assert.equal(result.createdIncident, false);
  assert.equal(result.incident.id, candidate.id);
  assert.ok(calls.includes("linkIssueToIncident:iss-new->inc-existing"));
  assert.ok(!calls.some((call) => call.startsWith("createOpen:")));
  assert.ok(Math.max(...requestChars) < 100_000);
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
      issueId: "iss-linked",
      service: null,
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

test("intake: LLM error logs an error and marks issue 'failed'", async () => {
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
      issueId: "iss-linked",
      service: null,
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
  assert.ok(calls.includes("logger.error:llm grouping failed"));
  assert.ok(
    calls.some((c) =>
      c.startsWith("updateIssueGrouping:iss-new:failed:llm:LLM grouping failed: anthropic 500"),
    ),
  );
});

test("intake: mechanical grouping failure (budget) logs an error and marks issue 'failed'", async () => {
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
      issueId: "iss-linked",
      service: null,
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
        return {
          decision: "standalone",
          evidence: "Grouping agent exhausted its tool-use budget without a valid decision.",
          mechanicalFailure: "budget_exhausted",
        };
      },
    }),
  );
  assert.ok(calls.includes("logger.error:issue grouping mechanical failure: budget_exhausted"));
  assert.ok(
    calls.some((c) =>
      c.startsWith("updateIssueGrouping:iss-new:failed:llm:LLM grouping budget_exhausted"),
    ),
  );
});

test("intake: joins a same-trace incident that appears during the serialize lock", async () => {
  // The span exception's incident is opened by a racing transition while this
  // (log) transition is between its outside-lock grouping and the create. The
  // incident only becomes visible on the inside-lock same-trace re-check (the
  // 3rd cross-service candidate read); we must join it, not open a duplicate.
  const calls: string[] = [];
  const racer = makeIncident({ id: "inc-racer", service: "superlog-sample-nextjs" });
  const issue = makeIssue({
    id: "iss-log",
    service: "superlog-sample",
    exceptionType: "ERROR",
    lastSample: { traceId: "trace-1", spanId: "span-log" } as schema.Issue["lastSample"],
  });

  let crossServiceReads = 0;
  const base = makeRepo({ calls });
  const repo: IntakeRepository = {
    ...base,
    async findOpenIncidentCandidates(_issue, queryOpts) {
      calls.push(`findOpenIncidentCandidates:${queryOpts.filterService}`);
      if (queryOpts.filterService) return [];
      crossServiceReads += 1;
      return crossServiceReads >= 3 ? [racer] : [];
    },
    async loadLinkedIncidentIssues(incidents) {
      calls.push(`loadLinkedIncidentIssues:${incidents.length}`);
      return incidents.map((inc) => ({
        incidentId: inc.id,
        title: "span exception",
        exceptionType: "TypeError",
        message: null,
        topFrame: null,
        normalizedFrames: [],
        lastSample: { traceId: "trace-1", spanId: "span-exc" },
        lastSeen: NOW,
      })) as unknown as Awaited<ReturnType<IntakeRepository["loadLinkedIncidentIssues"]>>;
    },
    async findIncident(incidentId) {
      calls.push(`findIncident:${incidentId}`);
      return incidentId === "inc-racer" ? racer : undefined;
    },
  };
  const deps = makeDeps({
    repo,
    lifecycle: makeLifecycle({ calls }),
    calls,
    serializeCreate: (_key, fn) => fn(),
  });

  const result = await ensureIncidentForIssueWorkflow(issue, "new", deps);

  assert.equal(result.createdIncident, false);
  assert.equal(result.incident.id, "inc-racer");
  assert.ok(calls.includes("linkIssueToIncident:iss-log->inc-racer"));
  assert.ok(!calls.some((c) => c.startsWith("createOpen")));
});
