import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DIGEST_POLICY } from "./policy.js";
import type { DigestRepository } from "./repository.js";
import { runDigestForProjectWorkflow } from "./run.js";

test("a project digest loads settings and candidates only for that project", async () => {
  const calls: string[] = [];
  const repo: DigestRepository = {
    async findProjectSettings(projectId) {
      calls.push(`settings:${projectId}`);
      return {
        projectId,
        enabled: true,
        installationId: "installation-2",
        channelId: "channel-2",
        lastRunAt: null,
        runRequestedAt: null,
      };
    },
    async findActiveSlackInstallation() {
      return { id: "installation-2", botAccessToken: "xoxb-test" };
    },
    async listRunnableProjectSettings() {
      return [];
    },
    async stampLastRun() {},
    async clearRunRequest() {},
    async gatherCandidates(projectId) {
      calls.push(`candidates:${projectId}`);
      return [];
    },
  };

  await runDigestForProjectWorkflow(
    "project-2",
    {
      repo,
      policy: DEFAULT_DIGEST_POLICY,
      rank: async () => [],
      slack: { postDigest: async () => ({ ok: true, ts: "1" }) },
      logger: { info() {}, warn() {}, error() {} },
      now: () => new Date("2026-07-14T12:00:00Z"),
    },
    { force: true },
  );

  assert.deepEqual(calls, ["settings:project-2", "candidates:project-2"]);
});
