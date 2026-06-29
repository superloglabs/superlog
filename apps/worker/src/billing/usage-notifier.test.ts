import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureBalance } from "@superlog/billing";
import {
  type UsageNotificationEvent,
  type UsageNotifierDeps,
  buildUsageSlackText,
  isFreePlan,
  mapAutumnFeatures,
  notifyOrgUsage,
} from "./usage-notifier.js";

function capped(featureId: string, usage: number, granted: number): FeatureBalance {
  return { featureId, usage, granted, overageAllowed: false, unlimited: false };
}

type Harness = {
  deps: UsageNotifierDeps;
  events: UsageNotificationEvent[];
  slack: Array<{ orgId: string; text: string }>;
  claimed: number[][]; // each claimThresholds call's requested steps
};

function harness(overrides: Partial<UsageNotifierDeps> = {}): Harness {
  const events: UsageNotificationEvent[] = [];
  const slack: Array<{ orgId: string; text: string }> = [];
  const claimed: number[][] = [];
  const alreadyClaimed = new Set<number>(); // simulate persisted dedup rows
  const base: UsageNotifierDeps = {
    periodKey: () => "2026-06-01",
    hasMaxNotified: async () => false,
    fetchOrgUsage: async () => ({
      orgName: "Acme",
      balances: [capped("logs", 4_500_000, 5_000_000)], // 90%
    }),
    claimThresholds: async (_org, _period, thresholds) => {
      claimed.push(thresholds);
      const won = thresholds.filter((t) => !alreadyClaimed.has(t));
      for (const t of won) alreadyClaimed.add(t);
      return won;
    },
    fetchMembers: async () => [
      { userId: "u1", email: "a@acme.test" },
      { userId: "u2", email: "b@acme.test" },
    ],
    sendUsageEvent: async (e) => {
      events.push(e);
    },
    postSlack: async (orgId, text) => {
      slack.push({ orgId, text });
    },
    enforcement: false,
    manageBillingUrl: "https://superlog.sh/settings?scope=org&section=billing",
    ...overrides,
  };
  return { deps: base, events, slack, claimed };
}

test("fires at the highest crossed step, emailing every member + one Slack post", async () => {
  const h = harness();
  const r = await notifyOrgUsage(h.deps, "org_1");
  assert.equal(r.status, "sent");
  assert.equal(r.threshold, 85); // 90% crosses 50 and 85; highest sent
  assert.equal(r.feature, "logs");
  assert.equal(h.events.length, 2); // one per member
  assert.deepEqual(h.events.map((e) => e.email).sort(), ["a@acme.test", "b@acme.test"]);
  assert.ok(h.events.every((e) => e.threshold === 85 && e.pct === 90));
  assert.equal(h.slack.length, 1);
  assert.match(h.slack[0]?.text ?? "", /90% of its Free plan logs/);
  // Claimed both 50 and 85 (lower step marked silently).
  assert.deepEqual(h.claimed, [[50, 85]]);
});

test("paid / overage-allowed org is never notified", async () => {
  const h = harness({
    fetchOrgUsage: async () => ({
      orgName: "Acme",
      balances: [
        {
          featureId: "logs",
          usage: 9_000_000,
          granted: 5_000_000,
          overageAllowed: true,
          unlimited: false,
        },
      ],
    }),
  });
  const r = await notifyOrgUsage(h.deps, "org_1");
  assert.equal(r.status, "not_capped");
  assert.equal(h.events.length, 0);
  assert.equal(h.slack.length, 0);
});

test("below the first step does not claim or send", async () => {
  const h = harness({
    fetchOrgUsage: async () => ({
      orgName: "Acme",
      balances: [capped("logs", 100_000, 5_000_000)],
    }), // 2%
  });
  const r = await notifyOrgUsage(h.deps, "org_1");
  assert.equal(r.status, "below_threshold");
  assert.equal(h.claimed.length, 0);
  assert.equal(h.events.length, 0);
});

test("re-evaluation after the step is claimed is a no-op (dedup)", async () => {
  const h = harness();
  await notifyOrgUsage(h.deps, "org_1"); // fires 85
  const second = await notifyOrgUsage(h.deps, "org_1"); // 90% again, 50+85 already claimed
  assert.equal(second.status, "already_notified");
  assert.equal(h.events.length, 2); // unchanged — no second send
});

test("crossing 100% later fires 100 once (50/85 already claimed)", async () => {
  const h = harness();
  await notifyOrgUsage(h.deps, "org_1"); // 90% → fires 85, claims 50+85
  // Now usage jumps to the cap.
  h.deps.fetchOrgUsage = async () => ({
    orgName: "Acme",
    balances: [capped("logs", 5_000_000, 5_000_000)], // 100%
  });
  const r = await notifyOrgUsage(h.deps, "org_1");
  assert.equal(r.status, "sent");
  assert.equal(r.threshold, 100);
});

test("hasMaxNotified short-circuits before any Autumn call", async () => {
  let fetched = false;
  const h = harness({
    hasMaxNotified: async () => true,
    fetchOrgUsage: async () => {
      fetched = true;
      return null;
    },
  });
  const r = await notifyOrgUsage(h.deps, "org_1");
  assert.equal(r.status, "already_maxed");
  assert.equal(fetched, false);
});

test("a billing-provider error (null usage) is a silent no-op", async () => {
  const h = harness({ fetchOrgUsage: async () => null });
  const r = await notifyOrgUsage(h.deps, "org_1");
  assert.equal(r.status, "no_usage");
  assert.equal(h.events.length, 0);
});

test("mapAutumnFeatures reads granted/usage/flags from balances, skips missing", () => {
  // Shape from a live Autumn GET /v1/customers/{id}: balances keyed by feature_id.
  const balances = mapAutumnFeatures({
    balances: {
      spans: {
        feature_id: "spans",
        granted: 1_000_000,
        usage: 500_000,
        overage_allowed: false,
        unlimited: false,
      },
      logs: {
        feature_id: "logs",
        granted: 5_000_000,
        usage: 100,
        overage_allowed: true,
        unlimited: false,
      },
      investigations: {
        feature_id: "investigations",
        granted: 0,
        usage: 3,
        overage_allowed: false,
        unlimited: true,
      },
      // metric_points omitted → skipped
    },
  });
  assert.deepEqual(balances, [
    {
      featureId: "spans",
      usage: 500_000,
      granted: 1_000_000,
      overageAllowed: false,
      unlimited: false,
    },
    { featureId: "logs", usage: 100, granted: 5_000_000, overageAllowed: true, unlimited: false },
    { featureId: "investigations", usage: 3, granted: 0, overageAllowed: false, unlimited: true },
  ]);
});

test("mapAutumnFeatures tolerates a missing/empty balances object", () => {
  assert.deepEqual(mapAutumnFeatures(null), []);
  assert.deepEqual(mapAutumnFeatures({}), []);
  assert.deepEqual(mapAutumnFeatures({ balances: {} }), []);
});

test("isFreePlan: only true when every active subscription is the free plan", () => {
  // Free org (auto-enabled free subscription)
  assert.equal(isFreePlan({ subscriptions: [{ plan_id: "free", status: "active" }] }), true);
  // Paying org (grandfathered) — the Trellis case: hard-capped feature but NOT free
  assert.equal(
    isFreePlan({ subscriptions: [{ plan_id: "grandfathered", status: "active" }] }),
    false,
  );
  assert.equal(isFreePlan({ subscriptions: [{ plan_id: "payg", status: "active" }] }), false);
  // free + a paid add-on → not free
  assert.equal(
    isFreePlan({
      subscriptions: [
        { plan_id: "free", status: "active" },
        { plan_id: "pack_150", status: "active" },
      ],
    }),
    false,
  );
  // canceled-at-period-end paid sub still grants access (canceled_at set,
  // expires_at in the future) → NOT free, even alongside a free sub. This is the
  // cubic P1: don't drop a paid sub just because canceled_at is present.
  assert.equal(
    isFreePlan(
      {
        subscriptions: [
          { plan_id: "free", status: "active" },
          { plan_id: "payg", status: "active", canceled_at: 1000, expires_at: 5000 },
        ],
      },
      2000, // now < expires_at → paid access still live
    ),
    false,
  );
  // genuinely-lapsed paid sub (expires_at in the past) is ignored; remaining
  // active free → free.
  assert.equal(
    isFreePlan(
      {
        subscriptions: [
          { plan_id: "free", status: "active" },
          { plan_id: "payg", status: "active", canceled_at: 1000, expires_at: 5000 },
        ],
      },
      9000, // now > expires_at → paid access has lapsed
    ),
    true,
  );
  // status `expired` paid sub is ignored regardless of timestamps.
  assert.equal(
    isFreePlan({
      subscriptions: [
        { plan_id: "free", status: "active" },
        { plan_id: "payg", status: "expired" },
      ],
    }),
    true,
  );
  // no active subscriptions / unknown shape → not free (stay silent)
  assert.equal(isFreePlan({ subscriptions: [] }), false);
  assert.equal(isFreePlan(null), false);
  assert.equal(isFreePlan({}), false);
});

test("100% Slack copy differs by enforcement + feature", () => {
  const url = "https://x/billing";
  // Pre-enforcement: warns about upcoming interruption.
  assert.match(
    buildUsageSlackText({
      orgName: "Acme",
      feature: "spans",
      pct: 100,
      threshold: 100,
      enforcement: false,
      manageBillingUrl: url,
    }),
    /reached its Free plan spans limit/,
  );
  // Post-enforcement telemetry: dropped.
  assert.match(
    buildUsageSlackText({
      orgName: "Acme",
      feature: "spans",
      pct: 100,
      threshold: 100,
      enforcement: true,
      manageBillingUrl: url,
    }),
    /new spans are being dropped/,
  );
  // Post-enforcement investigations: paused.
  assert.match(
    buildUsageSlackText({
      orgName: "Acme",
      feature: "investigations",
      pct: 100,
      threshold: 100,
      enforcement: true,
      manageBillingUrl: url,
    }),
    /new investigations are paused/,
  );
});
