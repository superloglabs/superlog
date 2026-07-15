import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldDeliverLinearTicket } from "./completion-policy.js";

test("policy never blocks every boundary, including updates to an existing ticket", () => {
  for (const boundary of ["pr_delivered", "investigation_handoff", "incident_resolved"] as const) {
    assert.equal(
      shouldDeliverLinearTicket({
        policy: "never",
        boundary,
        createOnResolve: true,
        runHasTicket: true,
      }),
      false,
    );
  }
});

test("on_ready_to_pr files at the PR boundary and on findings handoff", () => {
  assert.equal(
    shouldDeliverLinearTicket({
      policy: "on_ready_to_pr",
      boundary: "pr_delivered",
      createOnResolve: false,
    }),
    true,
  );
  assert.equal(
    shouldDeliverLinearTicket({
      policy: "on_ready_to_pr",
      boundary: "investigation_handoff",
      createOnResolve: false,
    }),
    true,
  );
});

test("incident-resolving completions follow the create-ticket-on-resolve toggle", () => {
  assert.equal(
    shouldDeliverLinearTicket({
      policy: "on_ready_to_pr",
      boundary: "incident_resolved",
      createOnResolve: true,
    }),
    true,
  );
  assert.equal(
    shouldDeliverLinearTicket({
      policy: "on_ready_to_pr",
      boundary: "incident_resolved",
      createOnResolve: false,
    }),
    false,
  );
});

test("policy always files on incident-resolving completions regardless of the toggle", () => {
  assert.equal(
    shouldDeliverLinearTicket({
      policy: "always",
      boundary: "incident_resolved",
      createOnResolve: false,
    }),
    true,
  );
});

test("a run that already filed a ticket may update it at resolution", () => {
  assert.equal(
    shouldDeliverLinearTicket({
      policy: "on_ready_to_pr",
      boundary: "incident_resolved",
      createOnResolve: false,
      runHasTicket: true,
    }),
    true,
  );
});
