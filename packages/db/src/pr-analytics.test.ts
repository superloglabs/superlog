import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { setAnalyticsClientForTests } from "./analytics.js";
import { captureAgentPrLifecycleEvent, daysBetween } from "./pr-analytics.js";

type Captured = { distinctId: string; event: string; properties?: Record<string, unknown> };

function recorder() {
  const events: Captured[] = [];
  return {
    events,
    capture(args: Captured) {
      events.push(args);
    },
  };
}

const pr = {
  id: "pr-uuid-1",
  incidentId: "incident-1",
  agentRunId: "run-1",
  repoFullName: "acme/storefront",
  prNumber: 42,
  url: "https://github.com/acme/storefront/pull/42",
};

const org = { id: "org-1", name: "Acme" };

beforeEach(() => setAnalyticsClientForTests(undefined));
after(() => setAnalyticsClientForTests(undefined));

test("opened event carries the shared PR properties, keyed by the PR row id", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureAgentPrLifecycleEvent({ kind: "opened", pr, org });

  assert.equal(rec.events.length, 1);
  const [ev] = rec.events;
  assert.ok(ev);
  assert.equal(ev.event, "agent_pr_opened");
  assert.equal(ev.distinctId, "pr-uuid-1");
  assert.equal(ev.properties?.pr_id, "pr-uuid-1");
  assert.equal(ev.properties?.incident_id, "incident-1");
  assert.equal(ev.properties?.agent_run_id, "run-1");
  assert.equal(ev.properties?.org_id, "org-1");
  assert.equal(ev.properties?.org_name, "Acme");
  assert.equal(ev.properties?.repo, "acme/storefront");
  assert.equal(ev.properties?.pr_number, 42);
  assert.equal(ev.properties?.url, pr.url);
  // PRs are not people: never create a person profile per PR.
  assert.equal(ev.properties?.$process_person_profile, false);
});

test("accepted event includes days_to_accept and merged_by", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureAgentPrLifecycleEvent({
    kind: "accepted",
    pr,
    org,
    daysToOutcome: 2.5,
    mergedByLogin: "octocat",
  });

  const [ev] = rec.events;
  assert.ok(ev);
  assert.equal(ev.event, "agent_pr_accepted");
  assert.equal(ev.properties?.days_to_accept, 2.5);
  assert.equal(ev.properties?.merged_by, "octocat");
});

test("rejected event includes the reason and days_to_reject", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureAgentPrLifecycleEvent({
    kind: "rejected",
    pr,
    org,
    reason: "closed_unmerged",
    daysToOutcome: 7,
  });

  const [ev] = rec.events;
  assert.ok(ev);
  assert.equal(ev.event, "agent_pr_rejected");
  assert.equal(ev.properties?.reason, "closed_unmerged");
  assert.equal(ev.properties?.days_to_reject, 7);
});

test("negative_reaction is its own standalone signal event", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureAgentPrLifecycleEvent({ kind: "negative_reaction", pr, org });

  const [ev] = rec.events;
  assert.ok(ev);
  assert.equal(ev.event, "agent_pr_negative_reaction");
  assert.equal(ev.properties?.pr_id, "pr-uuid-1");
});

test("org is optional so an unresolvable incident still produces an event", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureAgentPrLifecycleEvent({ kind: "opened", pr, org: null });

  const [ev] = rec.events;
  assert.ok(ev);
  assert.equal(ev.properties?.org_id, undefined);
  assert.equal(ev.properties?.pr_id, "pr-uuid-1");
});

test("daysBetween returns fractional days and null without both endpoints", () => {
  const opened = new Date("2026-07-01T00:00:00Z");
  const merged = new Date("2026-07-02T12:00:00Z");
  assert.equal(daysBetween(opened, merged), 1.5);
  assert.equal(daysBetween(null, merged), null);
  assert.equal(daysBetween(opened, null), null);
});
