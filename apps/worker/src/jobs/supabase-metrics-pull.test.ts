import "../agent-run.test-env.js";
import { strict as assert } from "node:assert";
import test from "node:test";
import type { JobDeps } from "../jobs.js";
import {
  createSupabaseMetricsPullJob,
  isSupabaseMetricIntakeDelivered,
} from "./supabase-metrics-pull.js";

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
  assert.equal(enabled.expireInSeconds, 300);
});

test("only accepted metric payloads are recorded as delivered", () => {
  assert.equal(isSupabaseMetricIntakeDelivered(202), true);
  assert.equal(isSupabaseMetricIntakeDelivered(400), false);
  assert.equal(isSupabaseMetricIntakeDelivered(402), false);
  assert.equal(isSupabaseMetricIntakeDelivered(413), false);
  assert.equal(isSupabaseMetricIntakeDelivered(429), false);
  assert.equal(isSupabaseMetricIntakeDelivered(500), false);
});
