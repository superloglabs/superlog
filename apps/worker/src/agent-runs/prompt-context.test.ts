import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import { buildAgentRunIssueSummaries } from "./prompt-context.js";

test("agent run issue context retains every issue while enriching only the 50 newest traces", async () => {
  const issues = Array.from({ length: 51 }, (_, index) => makeIssue(index + 1)).reverse();
  const enrichedIssueIds: string[] = [];

  const summaries = await buildAgentRunIssueSummaries("project-1", issues, {
    async buildWithTrace(_projectId, issue) {
      enrichedIssueIds.push(issue.id);
      return {
        id: issue.id,
        title: issue.title,
        exceptionType: issue.exceptionType,
        message: issue.message,
        topFrame: issue.topFrame,
        normalizedFrames: issue.normalizedFrames,
        stacktrace: null,
        sessionId: null,
        lastSample: issue.lastSample,
        traceContext: `trace:${issue.id}`,
        alertEpisode: null,
      };
    },
  });

  assert.equal(summaries.length, 51);
  assert.equal(enrichedIssueIds.includes("issue-1"), true);
  assert.equal(enrichedIssueIds.includes("issue-51"), false);
  assert.equal(summaries[0]?.traceContext, null);
  assert.equal(summaries[0]?.title, "Issue 51");
  assert.equal(summaries[50]?.traceContext, "trace:issue-1");
});

test("agent run issue context enriches no more than eight traces concurrently", async () => {
  const issues = Array.from({ length: 16 }, (_, index) => makeIssue(index + 1));
  let activeEnrichments = 0;
  let maxActiveEnrichments = 0;

  await buildAgentRunIssueSummaries("project-1", issues, {
    async buildWithTrace(_projectId, issue) {
      activeEnrichments += 1;
      maxActiveEnrichments = Math.max(maxActiveEnrichments, activeEnrichments);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeEnrichments -= 1;
      return {
        id: issue.id,
        title: issue.title,
        exceptionType: issue.exceptionType,
        message: issue.message,
        topFrame: issue.topFrame,
        normalizedFrames: issue.normalizedFrames,
        stacktrace: null,
        sessionId: null,
        lastSample: issue.lastSample,
        traceContext: `trace:${issue.id}`,
        alertEpisode: null,
      };
    },
  });

  assert.equal(maxActiveEnrichments, 8);
});

function makeIssue(index: number): schema.Issue {
  const seenAt = new Date(2026, 7, 24, 20, 0, 0, -index);
  return {
    id: `issue-${index}`,
    projectId: "project-1",
    fingerprint: `fingerprint-${index}`,
    kind: "span",
    service: "api",
    exceptionType: `Exception${index}`,
    title: `Issue ${index}`,
    message: `message-${index}`,
    topFrame: `frame-${index}`,
    normalizedFrames: [`frame-${index}`],
    lastSample: {
      kind: "span",
      service: "api",
      severity: "ERROR",
      message: `message-${index}`,
      body: null,
      exceptionType: `Exception${index}`,
      topFrame: `frame-${index}`,
      normalizedFrames: [`frame-${index}`],
      stacktrace: null,
      traceId: `trace-${index}`,
      spanId: `span-${index}`,
      seenAt: seenAt.toISOString(),
    },
    firstSeen: seenAt,
    lastSeen: seenAt,
    status: "open",
    silencedAt: null,
    escalationTrigger: null,
    observationStartedAt: null,
    observationBaselineEventCount: null,
    observationLastEvaluatedAt: null,
    observationLastEventCount: null,
    lastAlertedAt: null,
    slackMessageTs: null,
    eventCount: 1,
    groupingState: "grouped",
    groupingSource: null,
    groupingReason: null,
    groupingAttemptedAt: null,
    groupingAttemptCount: 0,
    createdAt: seenAt,
  };
}
