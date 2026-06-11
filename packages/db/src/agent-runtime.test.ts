import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_RUN_PROVIDERS,
  DEFAULT_AGENT_RUN_PROVIDER,
  isAgentRunProvider,
  resolveDefaultAgentRunProvider,
} from "./agent-runtime.js";

test("agent runtime defaults to the community provider", () => {
  assert.equal(DEFAULT_AGENT_RUN_PROVIDER, "community");
});

test("resolveDefaultAgentRunProvider falls back to community when env is unset", () => {
  assert.equal(resolveDefaultAgentRunProvider({}), DEFAULT_AGENT_RUN_PROVIDER);
  assert.equal(
    resolveDefaultAgentRunProvider({ DEFAULT_AGENT_RUN_PROVIDER: "" }),
    DEFAULT_AGENT_RUN_PROVIDER,
  );
});

test("resolveDefaultAgentRunProvider honors a valid env override", () => {
  for (const provider of AGENT_RUN_PROVIDERS) {
    assert.equal(
      resolveDefaultAgentRunProvider({ DEFAULT_AGENT_RUN_PROVIDER: provider }),
      provider,
    );
  }
});

test("resolveDefaultAgentRunProvider rejects invalid env values loudly", () => {
  assert.throws(
    () => resolveDefaultAgentRunProvider({ DEFAULT_AGENT_RUN_PROVIDER: "antropic" }),
    /DEFAULT_AGENT_RUN_PROVIDER must be one of/,
  );
});

test("agent runtime validation accepts public and closed-overlay providers", () => {
  assert.deepEqual([...AGENT_RUN_PROVIDERS], ["community", "anthropic", "disabled"]);
  assert.equal(isAgentRunProvider("community"), true);
  assert.equal(isAgentRunProvider("anthropic"), true);
  assert.equal(isAgentRunProvider("disabled"), true);
  assert.equal(isAgentRunProvider("unknown"), false);
  assert.equal(isAgentRunProvider(null), false);
});
