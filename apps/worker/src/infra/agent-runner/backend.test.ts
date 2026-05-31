import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentRunnerBackend } from "./backend.js";

test("getAgentRunnerBackend returns a built-in disabled backend for community installs", async () => {
  const backend = await getAgentRunnerBackend("disabled");

  assert.equal(backend.name, "disabled");
  assert.equal(backend.maxRepoResources, 0);
  assert.equal(
    await backend.dispatchIntegrationToolCalls({ sessionId: "s", orgId: "o", incidentId: "i" }),
    0,
  );
  await assert.rejects(
    () =>
      backend.start({
        incidentId: "i",
        projectId: "p",
        orgId: "o",
        title: "Incident",
        service: null,
        issueSummaries: [],
        repoCandidates: [],
        mcpResource: null,
        linearInstallationId: null,
        linearTicketPolicy: "never",
        linearTicketInstructions: [],
        prPolicy: "never",
        githubConnected: false,
        customInstructions: "",
      }),
    /disabled/,
  );
});

test("getAgentRunnerBackend rejects unknown runtimes", async () => {
  await assert.rejects(() => getAgentRunnerBackend("unknown"), /unsupported agent runner backend/);
});
