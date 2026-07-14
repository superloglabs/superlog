import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { IncidentEvent, Issue } from "../api.ts";
import { IssueDetailView } from "./IssueDetailView.tsx";

const issue: Issue = {
  id: "issue-1",
  projectId: "project-1",
  fingerprint: "checkout-confirmation",
  kind: "span",
  service: "checkout-api",
  exceptionType: "CheckoutConfirmationError",
  title: "Checkout confirmation fails after payment succeeds",
  message: "Payment capture completes, but confirmation rendering raises.",
  topFrame: "renderConfirmation (checkout-api/src/confirmation.ts:118:21)",
  firstSeen: "2026-07-10T12:49:06.682Z",
  lastSeen: "2026-07-10T13:34:06.682Z",
  status: "open",
  silencedAt: null,
  escalationTrigger: null,
  observationStartedAt: null,
  eventCount: 184,
  groupingState: "grouped",
  groupingSource: "manual",
  groupingReason: "Repeated errors share the same checkout transition.",
  lastSample: null,
  symbolication: null,
  createdAt: "2026-07-10T13:36:06.682Z",
};

function timelineEvent(overrides: Partial<IncidentEvent>): IncidentEvent {
  return {
    id: "event-1",
    agentRunId: "run-1",
    kind: "issue_silenced",
    summary: "Issue silenced: Checkout confirmation fails after payment succeeds",
    detail: {
      issueId: issue.id,
      reason: "The payment is captured and the client safely retries confirmation.",
      evidence: "The retry completed successfully 240 ms later.",
    },
    createdAt: "2026-07-10T13:35:06.682Z",
    ...overrides,
  };
}

test("error detail is a full investigation workspace with a summary rail and evidence", () => {
  const html = renderToStaticMarkup(
    <IssueDetailView
      issue={issue}
      environment="production"
      onBack={() => {}}
      linkedIncident={<button type="button">Open linked incident</button>}
    />,
  );

  assert.match(html, /data-issue-detail-workspace="true"/);
  assert.match(html, /Errors/);
  assert.doesNotMatch(html, />Issues</);
  assert.match(html, /Checkout confirmation fails after payment succeeds/);
  assert.match(html, /Error overview/);
  assert.match(html, /Latest evidence/);
  assert.match(html, /184 events/);
  assert.match(html, /renderConfirmation/);
  assert.match(html, /Open linked incident/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /font-mono/);
});

test("error detail shows why the issue was silenced in its activity timeline", () => {
  const html = renderToStaticMarkup(
    <IssueDetailView
      issue={issue}
      environment="production"
      onBack={() => {}}
      timelineEvents={[timelineEvent({})]}
    />,
  );

  assert.match(html, /Activity/);
  assert.match(html, /Silenced/);
  assert.match(html, /The payment is captured and the client safely retries confirmation\./);
  assert.match(html, /The retry completed successfully 240 ms later\./);
});

test("error detail shows why the issue was placed under observation", () => {
  const html = renderToStaticMarkup(
    <IssueDetailView
      issue={issue}
      environment="production"
      onBack={() => {}}
      timelineEvents={[
        timelineEvent({
          kind: "issue_observed",
          detail: {
            issueId: issue.id,
            reason: "The upstream recovered, but the sample window is still too short.",
            evidence: "No failed payments in the last 12 minutes.",
          },
        }),
      ]}
    />,
  );

  assert.match(html, /Under observation/);
  assert.match(html, /The upstream recovered, but the sample window is still too short\./);
  assert.match(html, /No failed payments in the last 12 minutes\./);
});

test("error detail shows why the issue was resolved", () => {
  const html = renderToStaticMarkup(
    <IssueDetailView
      issue={issue}
      environment="production"
      onBack={() => {}}
      timelineEvents={[
        timelineEvent({
          kind: "issue_resolved",
          detail: {
            issueId: issue.id,
            reason: "The fix is live and the affected code path is healthy.",
            evidence: "The deploy completed and 2,400 subsequent checkouts succeeded.",
          },
        }),
      ]}
    />,
  );

  assert.match(html, /Resolved/);
  assert.match(html, /The fix is live and the affected code path is healthy\./);
  assert.match(html, /The deploy completed and 2,400 subsequent checkouts succeeded\./);
});

test("error detail shows system-generated resolution activity without a reason", () => {
  const html = renderToStaticMarkup(
    <IssueDetailView
      issue={issue}
      environment="production"
      onBack={() => {}}
      timelineEvents={[
        timelineEvent({
          kind: "issue_resolved",
          detail: { issueId: issue.id },
        }),
      ]}
    />,
  );

  assert.match(html, /Activity/);
  assert.match(html, /Resolved/);
});

test("an alert-episode error links straight to the alert that fired", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <IssueDetailView
        issue={{
          ...issue,
          kind: "alert",
          exceptionType: "AlertFired",
          triggeringAlert: { id: "alert-9", name: "checkout-api p95 latency > 500ms" },
        }}
        environment="production"
        onBack={() => {}}
      />
    </MemoryRouter>,
  );

  assert.match(html, /Triggered by/);
  assert.match(html, /checkout-api p95 latency &gt; 500ms/);
  assert.match(html, /href="\/alerts\/alert-9"/);
});

test("a normal error shows no alert link", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <IssueDetailView issue={issue} environment="production" onBack={() => {}} />
    </MemoryRouter>,
  );

  assert.doesNotMatch(html, /Triggered by/);
  assert.doesNotMatch(html, /href="\/alerts\//);
});
