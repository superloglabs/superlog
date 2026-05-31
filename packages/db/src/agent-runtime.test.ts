import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_RUN_PROVIDERS,
  DEFAULT_AGENT_RUN_PROVIDER,
  isAgentRunProvider,
} from "./agent-runtime.js";

test("agent runtime defaults to the community provider", () => {
  assert.equal(DEFAULT_AGENT_RUN_PROVIDER, "community");
});

test("agent runtime validation accepts public and closed-overlay providers", () => {
  assert.deepEqual([...AGENT_RUN_PROVIDERS], ["community", "anthropic", "disabled"]);
  assert.equal(isAgentRunProvider("community"), true);
  assert.equal(isAgentRunProvider("anthropic"), true);
  assert.equal(isAgentRunProvider("disabled"), true);
  assert.equal(isAgentRunProvider("unknown"), false);
  assert.equal(isAgentRunProvider(null), false);
});
