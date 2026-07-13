import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { captureServerEvent, setAnalyticsClientForTests } from "./analytics.js";

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

beforeEach(() => setAnalyticsClientForTests(undefined));
after(() => setAnalyticsClientForTests(undefined));

test("captureServerEvent forwards distinctId, event, and properties", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureServerEvent({
    distinctId: "user-1",
    event: "organization_created",
    properties: { org_id: "org-1", is_first_org: true },
  });

  assert.equal(rec.events.length, 1);
  const [ev] = rec.events;
  assert.ok(ev);
  assert.equal(ev.distinctId, "user-1");
  assert.equal(ev.event, "organization_created");
  assert.deepEqual(ev.properties, { org_id: "org-1", is_first_org: true });
});

test("captureServerEvent maps set / setOnce to $set / $set_once", () => {
  const rec = recorder();
  setAnalyticsClientForTests(rec);

  captureServerEvent({
    distinctId: "user-2",
    event: "user_signed_up",
    properties: { auth_method: "google" },
    set: { email: "a@b.com", name: "A B" },
    setOnce: { signup_source: "skill" },
  });

  const [ev] = rec.events;
  assert.ok(ev);
  assert.deepEqual(ev.properties, {
    auth_method: "google",
    $set: { email: "a@b.com", name: "A B" },
    $set_once: { signup_source: "skill" },
  });
});

test("captureServerEvent is a no-op when analytics is unconfigured", () => {
  // null = resolved-but-unconfigured; must not throw and must emit nothing.
  setAnalyticsClientForTests(null);
  assert.doesNotThrow(() => captureServerEvent({ distinctId: "u", event: "user_signed_up" }));
});

test("captureServerEvent swallows client errors so it never breaks the caller", () => {
  setAnalyticsClientForTests({
    capture() {
      throw new Error("network down");
    },
  });
  assert.doesNotThrow(() =>
    captureServerEvent({ distinctId: "u", event: "first_telemetry_received" }),
  );
});
