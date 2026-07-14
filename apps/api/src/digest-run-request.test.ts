import { strict as assert } from "node:assert";
import { test } from "node:test";
import { requestDigestRunForProject } from "./digest-run-request.js";

const NOW = new Date("2026-07-14T12:00:00Z");

test("requesting a project test digest records a one-shot command without changing its weekly schedule", async () => {
  const writes: Array<{ projectId: string; requestedAt: Date }> = [];
  const result = await requestDigestRunForProject(
    "project-1",
    {
      async findConfiguration() {
        return { installationId: "inst-1", channelId: "C1" };
      },
      async requestRun(projectId, requestedAt) {
        writes.push({ projectId, requestedAt });
      },
    },
    () => NOW,
  );

  assert.deepEqual(result, { status: "requested", requestedAt: NOW });
  assert.deepEqual(writes, [{ projectId: "project-1", requestedAt: NOW }]);
});

test("requesting a project test digest is rejected until that project's Slack destination is configured", async () => {
  let wrote = false;
  const result = await requestDigestRunForProject("project-1", {
    async findConfiguration() {
      return { installationId: null, channelId: null };
    },
    async requestRun() {
      wrote = true;
    },
  });

  assert.deepEqual(result, { status: "not_configured" });
  assert.equal(wrote, false);
});
