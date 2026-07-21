import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldCreateLinearTicketForTerminalOutcome,
  shouldOfferOpenPr,
} from "./completion-policy.js";

test("complete_investigation always attempts the connected Linear handoff", () => {
  assert.equal(shouldCreateLinearTicketForTerminalOutcome("complete_investigation", false), true);
});

test("resolve_incident follows the project's create-ticket-on-resolve toggle", () => {
  assert.equal(shouldCreateLinearTicketForTerminalOutcome("resolve_incident", true), true);
  assert.equal(shouldCreateLinearTicketForTerminalOutcome("resolve_incident", false), false);
});

test("Open a PR is offered only after a GitHub-connected findings-only completion", () => {
  assert.equal(
    shouldOfferOpenPr({
      completionKind: "investigation_complete",
      prPolicy: "never",
      githubConnected: true,
    }),
    true,
  );
  assert.equal(
    shouldOfferOpenPr({
      completionKind: null,
      prPolicy: "never",
      githubConnected: true,
    }),
    false,
  );
  assert.equal(
    shouldOfferOpenPr({
      completionKind: "investigation_complete",
      prPolicy: "never",
      githubConnected: false,
    }),
    false,
  );
  assert.equal(
    shouldOfferOpenPr({
      completionKind: "investigation_complete",
      prPolicy: "on_ready_to_pr",
      githubConnected: true,
    }),
    false,
  );
});
