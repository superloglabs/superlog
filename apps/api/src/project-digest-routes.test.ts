import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

test("project digest settings require access to the project in the route", async () => {
  const { Hono } = await import("hono");
  const { mountSettingsAuthed } = await import("./settings.js");
  const app = new Hono();
  mountSettingsAuthed(app);

  const response = await app.request("/api/projects/project-2/digest");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "project not found" });
});
