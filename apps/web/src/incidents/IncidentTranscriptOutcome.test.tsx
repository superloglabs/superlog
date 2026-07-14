import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IncidentEvent } from "../api.ts";
import { IncidentActivityFeed } from "./IncidentTranscript.tsx";

function outcomeToolEvent(id: string, name: string, input: Record<string, unknown>): IncidentEvent {
  return {
    id,
    agentRunId: "run-1",
    kind: "agent.custom_tool_use",
    summary: null,
    detail: { toolUse: { name, input } },
    createdAt: "2026-07-14T16:11:22.000Z",
  };
}

test("outcome records show every recorded finding, reason, and piece of evidence", () => {
  const html = renderToStaticMarkup(
    <IncidentActivityFeed
      events={[
        outcomeToolEvent("findings", "report_findings", {
          summary: "SiteWatch customer creation emits a false-positive error.",
          proposedTitle: "SiteWatch setup is reported as an error",
          rootCause:
            "The client returns the created organization before the error span is emitted.",
          rootCauseConfidence: 9,
          estimatedImpact: "Organization setup still completes successfully.",
          impactConfidence: 8,
          severity: "SEV-3",
          handoffNotes: "Verified the create path and ruled out a failed write.",
        }),
        outcomeToolEvent("silence", "silence_as_noise", {
          issueId: "issue-1",
          reason: "The operation succeeds and only the diagnostic span is wrong.",
          evidence: "The organization is returned with its persisted SiteWatch configuration.",
        }),
        outcomeToolEvent("resolve", "resolve_incident", {
          reason: "Every linked issue is classified and there is no customer impact.",
          evidence: "The successful response and persisted configuration prove setup completed.",
        }),
      ]}
    />,
  );

  assert.match(html, /Reported findings/);
  assert.match(html, /SiteWatch customer creation emits a false-positive error\./);
  assert.match(html, /SiteWatch setup is reported as an error/);
  assert.match(html, /The client returns the created organization/);
  assert.match(html, /Root cause confidence/);
  assert.match(html, />9</);
  assert.match(html, /Organization setup still completes successfully\./);
  assert.match(html, /Impact confidence/);
  assert.match(html, />8</);
  assert.match(html, /SEV-3/);
  assert.match(html, /Verified the create path and ruled out a failed write\./);

  assert.match(html, /Silenced as noise/);
  assert.match(html, /The operation succeeds and only the diagnostic span is wrong\./);
  assert.match(html, /The organization is returned with its persisted SiteWatch configuration\./);

  assert.match(html, /Resolved incident/);
  assert.match(html, /Every linked issue is classified and there is no customer impact\./);
  assert.match(html, /The successful response and persisted configuration prove setup completed\./);
});

test("observation records show the escalation trigger in operator language", () => {
  const html = renderToStaticMarkup(
    <IncidentActivityFeed
      events={[
        outcomeToolEvent("observe", "place_under_observation", {
          issueId: "issue-2",
          reason: "The failure was isolated, but the safe baseline is not established yet.",
          evidence: "Only one event occurred during the inspected six-hour window.",
          escalateOn: "events_per_minute",
          threshold: 5,
        }),
        outcomeToolEvent("observe-count", "place_under_observation", {
          issueId: "issue-3",
          reason: "Recurrence should reopen the investigation.",
          evidence: "The issue is currently quiet after a single transient failure.",
          escalateOn: "additional_events",
          threshold: 20,
        }),
      ]}
    />,
  );

  assert.match(html, /Placed under observation/);
  assert.match(html, /The failure was isolated, but the safe baseline is not established yet\./);
  assert.match(html, /Only one event occurred during the inspected six-hour window\./);
  assert.match(html, /Escalation trigger/);
  assert.match(html, /5 events per minute/);
  assert.match(html, /20 additional events/);
  assert.doesNotMatch(html, /events_per_minute/);
});
