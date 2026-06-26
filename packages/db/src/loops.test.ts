import assert from "node:assert/strict";
import { test } from "node:test";

// loops.ts transitively imports the db client, which requires DATABASE_URL at
// module load. postgres-js connects lazily, so a dummy URL + dynamic import lets
// us unit-test the pure payload builder without a real database.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { DEFAULT_LOOPS_USAGE_EVENT, buildLoopsUsageThresholdPayload } = await import("./loops.js");

const base = {
  email: "owner@acme.test",
  userId: "user_1",
  orgId: "org_1",
  orgName: "Acme",
  feature: "spans",
  pct: 87,
  threshold: 85,
  enforcement: false,
  manageBillingUrl: "https://superlog.sh/settings?scope=org&section=billing",
};

test("buildLoopsUsageThresholdPayload maps the input to a flat string event", () => {
  const p = buildLoopsUsageThresholdPayload(base);
  assert.equal(p.email, "owner@acme.test");
  assert.equal(p.userId, "user_1");
  assert.equal(p.eventName, DEFAULT_LOOPS_USAGE_EVENT);
  assert.equal(p.source, "Superlog usage");
  assert.deepEqual(p.eventProperties, {
    orgId: "org_1",
    orgName: "Acme",
    feature: "spans",
    pct: "87",
    threshold: "85",
    enforcement: "false",
    manageBillingUrl: "https://superlog.sh/settings?scope=org&section=billing",
  });
});

test("pct is floored and clamped to >= 0; enforcement is stringified", () => {
  const p = buildLoopsUsageThresholdPayload({
    ...base,
    pct: 142.9,
    threshold: 100,
    enforcement: true,
  });
  assert.equal(p.eventProperties.pct, "142");
  assert.equal(p.eventProperties.threshold, "100");
  assert.equal(p.eventProperties.enforcement, "true");
});

test("a custom event name containing ':' is rejected (Loops constraint)", () => {
  assert.throws(() => buildLoopsUsageThresholdPayload(base, "bad:name"));
});
