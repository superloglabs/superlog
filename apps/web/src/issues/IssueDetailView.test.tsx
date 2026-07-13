import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Issue } from "../api.ts";
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
