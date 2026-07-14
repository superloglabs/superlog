import { strict as assert } from "node:assert";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { IncidentDetailContent, ResolutionProposalBanner } from "./Issues.tsx";
import type { Incident, PendingResolutionProposal } from "./api.ts";

test("read-only incident detail preserves the product layout without mutation controls", () => {
  const incident: Incident = {
    id: "incident-1",
    projectId: "project-1",
    service: "api",
    environment: "production",
    title: "Checkout failures",
    codename: "steady-amber",
    severity: "SEV-2",
    status: "open",
    noiseReason: null,
    noiseResolvedAt: null,
    firstSeen: "2026-07-06T08:00:00.000Z",
    lastSeen: "2026-07-06T08:10:00.000Z",
    issueCount: 1,
    slackChannelId: null,
    slackThreadTs: null,
    agentSummary: "Checkout started returning 500s.",
    rootCauseText: "A checkout repository method threw on null totals.",
    rootCauseConfidence: 82,
    estimatedImpactText: "Checkout requests failed.",
    estimatedImpactConfidence: 75,
    suggestedSeverity: "SEV-2",
    noiseClassification: null,
    resolutionClassification: null,
    findingsAgentRunId: null,
    autoInvestigateBlockedReason: null,
    createdAt: "2026-07-06T08:00:00.000Z",
    updatedAt: "2026-07-06T08:20:00.000Z",
  };
  const queryClient = new QueryClient();

  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        null,
        createElement(IncidentDetailContent, {
          incident,
          issues: [],
          agentRun: null,
          events: [],
          eventsLoading: false,
          eventsError: null,
          onClose: () => {},
          onViewIssue: () => {},
          onStatusAction: () => {},
          updatingIncident: false,
          readOnly: true,
        }),
      ),
    ),
  );

  assert.match(html, /Checkout failures/);
  assert.match(html, />Activity</);
  assert.match(html, />Findings</);
  assert.match(html, />PR</);
  assert.doesNotMatch(html, />Not an issue</);
  assert.doesNotMatch(html, />Problem resolved</);
  assert.doesNotMatch(html, />Give feedback</);
  assert.doesNotMatch(html, /Reply to the investigation/);
});

test("read-only recovery proposal keeps its findings without decision controls", () => {
  const proposal: PendingResolutionProposal = {
    id: "proposal-1",
    sourceKind: "autorecovery",
    confidence: "high",
    proposedReasonCode: "signal_recovered",
    proposedReasonText: "The error rate returned to its baseline.",
    proposedAt: "2026-07-06T08:20:00.000Z",
  };

  const html = renderToStaticMarkup(
    createElement(ResolutionProposalBanner, {
      proposal,
      readOnly: true,
    }),
  );

  assert.match(html, /Recovery detected/);
  assert.match(html, /The error rate returned to its baseline/);
  assert.doesNotMatch(html, />Dismiss</);
  assert.doesNotMatch(html, />Confirm resolution</);
});
