import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  type LinkedIncidentIssue,
  buildGroupingCandidate,
  findHeuristicIncidentMatch,
  findSameTraceIncidentMatch,
  groupingIssueInput,
  overlapCount,
} from "./domain.js";

test("overlapCount compares only the top five normalized frames", () => {
  assert.equal(overlapCount(["a", "b", "c", "d", "e", "ignored"], ["x", "b", "c"]), 2);
  assert.equal(overlapCount(["ignored"], ["a", "b", "c", "d", "e", "ignored"]), 0);
});

test("findHeuristicIncidentMatch joins the strongest stack-frame match", () => {
  const issue = makeIssue(["svc/a.ts", "svc/b.ts", "svc/c.ts"]);
  const candidates = [makeIncident("inc-1"), makeIncident("inc-2")];
  const linked: LinkedIncidentIssue[] = [
    makeLinkedIssue("inc-1", ["svc/a.ts", "other.ts"]),
    makeLinkedIssue("inc-2", ["svc/a.ts", "svc/b.ts", "svc/c.ts"]),
  ];

  const match = findHeuristicIncidentMatch(issue, candidates, linked);

  assert.equal(match?.incident.id, "inc-2");
  assert.equal(match?.source, "heuristic");
  assert.equal(match?.reason, "Matched existing incident by 3 overlapping stack frames.");
});

test("findSameTraceIncidentMatch joins the incident sharing the issue's trace id", () => {
  // A log observation of an error: no stack-frame overlap and a severity-derived
  // exception type, but the same request (trace id) as an existing incident.
  const issue = {
    ...makeIssue(["svc/log.ts"]),
    exceptionType: "ERROR",
    lastSample: { traceId: "trace-xyz", spanId: "span-1" },
  } as schema.Issue;
  const candidates = [makeIncident("inc-1"), makeIncident("inc-2")];
  const linked: LinkedIncidentIssue[] = [
    {
      ...makeLinkedIssue("inc-2", ["svc/route.ts"]),
      lastSample: { traceId: "trace-xyz", spanId: "span-9" } as LinkedIncidentIssue["lastSample"],
    },
    {
      ...makeLinkedIssue("inc-1", ["other.ts"]),
      lastSample: { traceId: "trace-other", spanId: "span-2" } as LinkedIncidentIssue["lastSample"],
    },
  ];

  const match = findSameTraceIncidentMatch(issue, candidates, linked);

  assert.equal(match?.incident.id, "inc-2");
  assert.equal(match?.source, "heuristic");
  assert.match(match?.reason ?? "", /trace-xyz/);
});

test("findSameTraceIncidentMatch returns null when the issue has no trace id", () => {
  const issue = makeIssue(["svc/a.ts"]); // lastSample is null
  const candidates = [makeIncident("inc-1")];
  const linked: LinkedIncidentIssue[] = [makeLinkedIssue("inc-1", ["svc/a.ts"])];

  assert.equal(findSameTraceIncidentMatch(issue, candidates, linked), null);
});

test("groupingIssueInput and buildGroupingCandidate keep LLM input shape explicit", () => {
  const issue = {
    ...makeIssue(["svc/a.ts"]),
    lastSample: { traceId: "trace-1", spanId: "span-1", stacktrace: "stack" },
  } as schema.Issue;
  const candidate = buildGroupingCandidate(makeIncident("inc-1"), [
    {
      ...makeLinkedIssue("inc-1", ["svc/a.ts"]),
      lastSample: { traceId: "trace-2", spanId: "span-2" } as LinkedIncidentIssue["lastSample"],
    },
  ]);

  assert.deepEqual(groupingIssueInput(issue), {
    id: "issue-1",
    title: "Issue title",
    service: "api",
    exceptionType: "TypeError",
    message: "boom",
    topFrame: "svc/a.ts",
    normalizedFrames: ["svc/a.ts"],
    observedAt: "2026-07-17T10:05:00.000Z",
    stacktrace: "stack",
    traceId: "trace-1",
    spanId: "span-1",
    logAttrs: null,
  });
  assert.ok(candidate?.representative);
  assert.equal(candidate.representative.traceId, "trace-2");
  assert.deepEqual(candidate.representative.normalizedFrames, ["svc/a.ts"]);
  // Linked issues now travel with the candidate so inspect_incident can show
  // stack traces and code locations.
  assert.equal(candidate.issues?.length, 1);
  assert.equal(candidate.issues?.[0]?.id, "iss-linked");
});

test("groupingIssueInput compacts an oversized generated-code frame without losing diagnostics", () => {
  const headline =
    'Internal server error: Failed to resolve import "./missing.png" from "app/feature.tsx".';
  const stackTail = "at TransformPluginContext.error\nat normalizeUrl";
  const generatedLine = `1 | ${"jsxDEV(path, generatedMetadata);".repeat(25_000)}`;
  const message = `${headline}\nPlugin: vite:import-analysis\n${generatedLine}\n${stackTail}`;
  const issue = { ...makeIssue([]), message } as schema.Issue;

  const input = groupingIssueInput(issue);

  assert.ok(message.length > 600_000);
  assert.ok((input.message?.length ?? 0) <= 12_000);
  assert.match(input.message ?? "", /Failed to resolve import/);
  assert.match(input.message ?? "", /omitted [\d,]+ chars/);
  assert.match(input.message ?? "", /at normalizeUrl/);
});

test("buildGroupingCandidate reads log-sample stacktraces and strips them from logAttrs", () => {
  const candidate = buildGroupingCandidate(makeIncident("inc-1"), [
    {
      ...makeLinkedIssue("inc-1", []),
      lastSample: {
        logAttrs: {
          "exception.stacktrace": "Traceback (most recent call last): boom",
          "code.file.path": "/app/x.py",
        },
      } as unknown as LinkedIncidentIssue["lastSample"],
    },
  ]);
  assert.equal(candidate?.issues?.[0]?.stacktrace, "Traceback (most recent call last): boom");
  assert.deepEqual(candidate?.issues?.[0]?.logAttrs, { "code.file.path": "/app/x.py" });
});

function makeIssue(normalizedFrames: string[]): schema.Issue {
  return {
    id: "issue-1",
    title: "Issue title",
    service: "api",
    exceptionType: "TypeError",
    message: "boom",
    topFrame: normalizedFrames[0] ?? null,
    normalizedFrames,
    firstSeen: new Date("2026-07-17T10:00:00.000Z"),
    lastSeen: new Date("2026-07-17T10:05:00.000Z"),
    lastSample: null,
  } as schema.Issue;
}

function makeIncident(id: string): schema.Incident {
  return {
    id,
    title: `Incident ${id}`,
    service: "api",
    firstSeen: new Date(0),
    lastSeen: new Date(1),
    issueCount: 1,
  } as schema.Incident;
}

function makeLinkedIssue(incidentId: string, normalizedFrames: string[]): LinkedIncidentIssue {
  return {
    incidentId,
    issueId: "iss-linked",
    service: null,
    title: "Linked issue",
    exceptionType: "TypeError",
    message: "boom",
    topFrame: normalizedFrames[0] ?? null,
    normalizedFrames,
    lastSample: null,
    lastSeen: new Date(1),
  };
}
