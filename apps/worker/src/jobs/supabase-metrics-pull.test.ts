import "../agent-run.test-env.js";
import { strict as assert } from "node:assert";
import test from "node:test";
import type { JobDeps } from "../jobs.js";
import { createSupabaseMetricsPullJob } from "./supabase-metrics-pull.js";

test("Supabase query metrics run every five minutes only with OAuth and secret storage", async () => {
  const disabled = createSupabaseMetricsPullJob({ env: {} });
  assert.equal(await disabled.create({} as JobDeps), null);

  const enabled = createSupabaseMetricsPullJob({
    env: {
      SUPABASE_CLIENT_ID: "client-id",
      SUPABASE_CLIENT_SECRET: "client-secret",
      AGENT_SECRETS_KEY: "encryption-key",
    },
  });
  assert.equal(enabled.schedule, "*/5 * * * *");
  assert.equal(enabled.policy, "exclusive");
});

test("metric intake acknowledges accepted and permanently rejected payloads", async () => {
  const { isSupabaseMetricIntakeAcknowledged } = await import("./supabase-metrics-pull.js");
  assert.equal(isSupabaseMetricIntakeAcknowledged(202), true);
  assert.equal(isSupabaseMetricIntakeAcknowledged(400), true);
  assert.equal(isSupabaseMetricIntakeAcknowledged(402), true);
  assert.equal(isSupabaseMetricIntakeAcknowledged(413), true);
  assert.equal(isSupabaseMetricIntakeAcknowledged(429), false);
  assert.equal(isSupabaseMetricIntakeAcknowledged(500), false);
});
