import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldCreateLinearTicketForTerminalOutcome } from "./completion-policy.js";

test("complete_investigation always attempts the connected Linear handoff", () => {
  assert.equal(shouldCreateLinearTicketForTerminalOutcome("complete_investigation", false), true);
});

test("resolve_incident follows the project's create-ticket-on-resolve toggle", () => {
  assert.equal(shouldCreateLinearTicketForTerminalOutcome("resolve_incident", true), true);
  assert.equal(shouldCreateLinearTicketForTerminalOutcome("resolve_incident", false), false);
});
