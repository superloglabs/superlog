import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { postLinearIncidentActivity } = await import("./agent-session.js");

test("posts an elicitation to the Linear session rooted at an incident", async () => {
  const sent: unknown[] = [];

  await postLinearIncidentActivity("incident-1", "elicitation", "Which repository owns this?", {
    findTarget: async (incidentId) => {
      assert.equal(incidentId, "incident-1");
      return { accessToken: "token", agentSessionId: "session-1" };
    },
    createActivity: async (args) => {
      sent.push(args);
      return { id: "activity-1" };
    },
  });

  assert.deepEqual(sent, [
    {
      accessToken: "token",
      agentSessionId: "session-1",
      type: "elicitation",
      body: "Which repository owns this?",
    },
  ]);
});

test("does nothing when the incident did not originate in Linear", async () => {
  let posted = false;
  await postLinearIncidentActivity("incident-2", "response", "Done", {
    findTarget: async () => null,
    createActivity: async () => {
      posted = true;
      return { id: "activity-2" };
    },
  });
  assert.equal(posted, false);
});
