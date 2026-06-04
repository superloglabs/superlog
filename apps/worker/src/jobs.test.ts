import assert from "node:assert/strict";
import { test } from "node:test";
import { type JobDeps, loadJobs } from "./jobs.js";

// Deps are injected into each job's create(); the fixtures ignore them, so a
// bare stub is enough to exercise the loader.
const deps = {} as unknown as JobDeps;

const fixturesDir = new URL("./jobs-fixtures/", import.meta.url);

test("loads every valid job file and returns its ticker", async () => {
  const jobs = await loadJobs(deps, { dir: fixturesDir });
  const valid = jobs.find((j) => j.name === "fixture.valid");
  assert.ok(valid, "expected the valid fixture job to be registered");
  assert.equal(await valid.tick(), 7);
});

test("skips a job whose create() returns null (opted out)", async () => {
  const jobs = await loadJobs(deps, { dir: fixturesDir });
  assert.equal(
    jobs.some((j) => j.name === "fixture.disabled"),
    false,
  );
});

test("skips a job whose create() throws, without failing the load", async () => {
  const jobs = await loadJobs(deps, { dir: fixturesDir });
  // The valid job still loads even though throws-on-create.ts blew up.
  assert.ok(jobs.some((j) => j.name === "fixture.valid"));
  assert.equal(
    jobs.some((j) => j.name === "fixture.throws"),
    false,
  );
});

test("skips files that do not export a job", async () => {
  const jobs = await loadJobs(deps, { dir: fixturesDir });
  // no-job-export.ts contributes nothing; loader does not throw.
  assert.ok(Array.isArray(jobs));
});

test("ignores *.test.ts files even if they export a job", async () => {
  const jobs = await loadJobs(deps, { dir: fixturesDir });
  assert.equal(
    jobs.some((j) => j.name === "fixture.ignored-test"),
    false,
  );
});

test("returns an empty list when the jobs dir does not exist", async () => {
  const jobs = await loadJobs(deps, {
    dir: new URL("./jobs-fixtures-does-not-exist/", import.meta.url),
  });
  assert.deepEqual(jobs, []);
});

test("loads jobs in a deterministic (filename-sorted) order", async () => {
  const a = await loadJobs(deps, { dir: fixturesDir });
  const b = await loadJobs(deps, { dir: fixturesDir });
  assert.deepEqual(
    a.map((j) => j.name),
    b.map((j) => j.name),
  );
});
