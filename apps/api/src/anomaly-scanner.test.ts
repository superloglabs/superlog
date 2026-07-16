import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

test("scanner settings require project manager access before mutation", async () => {
  const { mountAnomalyScanner } = await import("./anomaly-scanner.js");
  const checkedProjects: string[] = [];
  const app = new Hono<{
    Variables: { userId: string; orgId: string | null };
  }>();
  mountAnomalyScanner(app, {
    requireProjectManagerContext: async (_context, projectId) => {
      checkedProjects.push(projectId);
      throw new HTTPException(403, { message: "forbidden" });
    },
  });

  const response = await app.request("/api/projects/project-1/anomaly-scanner", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(checkedProjects, ["project-1"]);
});
