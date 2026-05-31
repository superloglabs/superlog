import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentRunnerBackend } from "./backend.js";

const originalCommunityStateDir = process.env.COMMUNITY_AGENT_RUNNER_STATE_DIR;

test.afterEach(() => {
  if (originalCommunityStateDir === undefined) {
    Reflect.deleteProperty(process.env, "COMMUNITY_AGENT_RUNNER_STATE_DIR");
  } else {
    process.env.COMMUNITY_AGENT_RUNNER_STATE_DIR = originalCommunityStateDir;
  }
});

test("getAgentRunnerBackend returns the default community backend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "superlog-community-agent-"));
  process.env.COMMUNITY_AGENT_RUNNER_STATE_DIR = dir;
  try {
    const backend = await getAgentRunnerBackend("community");

    assert.equal(backend.name, "community");
    assert.equal(backend.maxRepoResources, 3);

    const session = await backend.start({
      incidentId: "i",
      projectId: "p",
      orgId: "o",
      title: "API errors on checkout",
      service: "api",
      issueSummaries: [
        {
          id: "issue-1",
          title: "TypeError in checkout",
          exceptionType: "TypeError",
          message: "Cannot read properties of undefined",
          topFrame: "checkout.ts:42",
          normalizedFrames: ["checkout.ts:42"],
          lastSample: null,
          traceContext: null,
        },
      ],
      repoCandidates: [],
      mcpResource: null,
      linearInstallationId: null,
      linearTicketPolicy: "never",
      linearTicketInstructions: [],
      prPolicy: "never",
      githubConnected: false,
      customInstructions: "",
    });
    const snapshot = await backend.collect(session.sessionId);

    assert.equal(snapshot.sessionId, session.sessionId);
    assert.equal(snapshot.status, "terminated");
    assert.equal(snapshot.activeSeconds, 0);
    assert.equal(snapshot.result?.state, "complete");
    assert.match(snapshot.result?.summary ?? "", /API errors on checkout/);
    assert.match(snapshot.result?.summary ?? "", /TypeError in checkout/);
    assert.equal(snapshot.result?.pr, null);
    assert.deepEqual(snapshot.unknownCustomTools, []);
    assert.equal(snapshot.modelUsage.model, "community/static");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
