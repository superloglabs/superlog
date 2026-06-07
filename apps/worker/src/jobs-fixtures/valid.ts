import type { JobDefinition } from "../jobs.js";

// A normal job: create() returns a handler. Records that it ran via a global so
// the test can assert invocation.
export const job: JobDefinition = {
  name: "fixture.valid",
  schedule: "*/5 * * * *",
  create: () => async () => {
    (globalThis as Record<string, unknown>).__fixtureValidRan = true;
  },
};
