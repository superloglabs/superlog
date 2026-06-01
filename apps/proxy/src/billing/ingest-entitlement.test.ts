import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type IngestSignal,
  createEntitlementCache,
  createIngestEntitlementGate,
  signalForPath,
} from "./ingest-entitlement.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

test("signalForPath maps OTLP endpoints to billing signals", () => {
  assert.equal(signalForPath("/v1/traces"), "spans");
  assert.equal(signalForPath("/v1/logs"), "logs");
  assert.equal(signalForPath("/v1/metrics"), "metric_points");
  assert.equal(signalForPath("/v1/whatever"), null);
});

test("cache miss fails OPEN, then reflects the refreshed verdict (blocked)", async () => {
  let checks = 0;
  const gate = createEntitlementCache({
    lookupOrgId: async () => "orgA",
    check: async () => {
      checks += 1;
      return false; // free org over cap
    },
  });
  // First request: nothing cached → allow (fail-open) + schedule refresh.
  assert.equal(gate.allows("p1", "spans"), true);
  await flush();
  // After the background refresh resolved, the org is blocked.
  assert.equal(gate.allows("p1", "spans"), false);
  assert.equal(checks, 1);
});

test("within TTL it serves from cache without re-checking", async () => {
  let checks = 0;
  let t = 1000;
  const gate = createEntitlementCache({
    lookupOrgId: async () => "orgA",
    check: async () => {
      checks += 1;
      return true;
    },
    ttlMs: 60_000,
    now: () => t,
  });
  gate.allows("p1", "spans");
  await flush();
  t += 30_000; // still within ttl
  gate.allows("p1", "spans");
  gate.allows("p1", "spans");
  await flush();
  assert.equal(checks, 1);
});

test("re-checks after the TTL expires", async () => {
  let checks = 0;
  let t = 1000;
  const gate = createEntitlementCache({
    lookupOrgId: async () => "orgA",
    check: async () => {
      checks += 1;
      return true;
    },
    ttlMs: 60_000,
    now: () => t,
  });
  gate.allows("p1", "spans");
  await flush();
  t += 61_000; // past ttl
  gate.allows("p1", "spans");
  await flush();
  assert.equal(checks, 2);
});

test("unknown org (no mapping) always allows", async () => {
  const gate = createEntitlementCache({
    lookupOrgId: async () => null,
    check: async () => false,
  });
  gate.allows("p1", "spans");
  await flush();
  assert.equal(gate.allows("p1", "spans"), true);
});

test("check error fails OPEN (billing outage never blocks ingest)", async () => {
  const gate = createEntitlementCache({
    lookupOrgId: async () => "orgA",
    check: async () => {
      throw new Error("autumn down");
    },
  });
  gate.allows("p1", "spans");
  await flush();
  assert.equal(gate.allows("p1", "spans"), true);
});

test("no AUTUMN_SECRET_KEY → gate disabled (null), never blocks", () => {
  const gate = createIngestEntitlementGate({
    lookupOrgForProject: async () => ({ orgId: "orgA" }),
    secretKey: null,
  });
  assert.equal(gate, null);
});
