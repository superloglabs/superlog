import assert from "node:assert/strict";
import { test } from "node:test";
import { linearTicketAcceptanceUnit } from "./linear-acceptance.js";

test("a findings-only run has a stable synthetic PR acceptance unit", () => {
  assert.deepEqual(
    linearTicketAcceptanceUnit({
      id: "ticket-row-1",
      incidentId: "incident-1",
      agentRunId: "run-1",
      url: "https://linear.app/acme/issue/ENG-42",
    }),
    {
      id: "linear:ticket-row-1",
      incidentId: "incident-1",
      agentRunId: "run-1",
      repoFullName: "linear",
      prNumber: 0,
      url: "https://linear.app/acme/issue/ENG-42",
    },
  );
});
