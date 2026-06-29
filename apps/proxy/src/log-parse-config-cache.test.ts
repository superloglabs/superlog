import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_LOG_PARSE_CONFIG } from "@superlog/db/log-severity";
import { createLogParseConfigCache } from "./log-parse-config-cache.js";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const config = (over = {}) => ({
  otlp: { enabled: true, severityKeys: ["lvl"], severityValueMap: {}, ...over },
  aws: { enabled: true, severityKeys: ["level"], severityValueMap: {} },
});

test("returns defaults before the first refresh resolves (fail-open)", () => {
  const cache = createLogParseConfigCache({ loadConfig: async () => config() });
  assert.deepEqual(cache.get("p1"), DEFAULT_LOG_PARSE_CONFIG);
});

test("serves the loaded config after a refresh", async () => {
  const c = clock();
  const cache = createLogParseConfigCache({ loadConfig: async () => config(), now: c.now });
  cache.get("p1"); // trigger load
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(cache.get("p1").otlp.severityKeys, ["lvl"]);
});

test("fails open to defaults when the loader throws", async () => {
  const cache = createLogParseConfigCache({
    loadConfig: async () => {
      throw new Error("db down");
    },
  });
  cache.get("p1");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(cache.get("p1"), DEFAULT_LOG_PARSE_CONFIG);
});
