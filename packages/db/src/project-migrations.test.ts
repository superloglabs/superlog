import assert from "node:assert/strict";
import { test } from "node:test";

// The lookup cache doesn't touch the db client, but importing the module pulls
// in ./client.js, which throws without a connection string. postgres-js
// connects lazily, so a dummy value is enough.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { createCutOverLookup } = await import("./project-migrations.js");

test("caches whether a project is cut over, including when it is not", async () => {
  let clock = 0;
  const answers = new Map<string, string | null>([["moved", "https://us.example.com"]]);
  const loads: string[] = [];
  const lookup = createCutOverLookup(
    async (projectId) => {
      loads.push(projectId);
      return answers.get(projectId) ?? null;
    },
    { ttlMs: 30_000, now: () => clock },
  );

  assert.equal(await lookup("moved"), "https://us.example.com");
  assert.equal(await lookup("stayed"), null);
  answers.set("stayed", "https://us.example.com");
  clock = 29_999;
  assert.equal(await lookup("moved"), "https://us.example.com");
  assert.equal(await lookup("stayed"), null);
  assert.deepEqual(loads, ["moved", "stayed"]);

  clock = 30_000;
  assert.equal(await lookup("stayed"), "https://us.example.com");
  assert.deepEqual(loads, ["moved", "stayed", "stayed"]);
});

test("keeps at most maxEntries projects", async () => {
  const loads: string[] = [];
  const lookup = createCutOverLookup(
    async (projectId) => {
      loads.push(projectId);
      return null;
    },
    { maxEntries: 2, now: () => 0 },
  );

  for (const projectId of ["a", "b", "c", "b", "a"]) await lookup(projectId);

  assert.deepEqual(loads, ["a", "b", "c", "a"]);
});
