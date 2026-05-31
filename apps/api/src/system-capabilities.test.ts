import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSystemCapabilities } from "./system-capabilities.js";

test("system capabilities default to the open-core community edition", () => {
  assert.deepEqual(buildSystemCapabilities({}), {
    edition: "community",
    billing: "none",
    managedAgents: false,
    ossAgents: true,
    cloudUpgradeLinks: true,
  });
});

test("system capabilities expose cloud billing and managed agents when explicitly enabled", () => {
  assert.deepEqual(
    buildSystemCapabilities({
      SUPERLOG_EDITION: "cloud",
      SUPERLOG_BILLING_PROVIDER: "stripe",
      SUPERLOG_MANAGED_AGENTS_ENABLED: "true",
    }),
    {
      edition: "cloud",
      billing: "stripe",
      managedAgents: true,
      ossAgents: true,
      cloudUpgradeLinks: false,
    },
  );
});
