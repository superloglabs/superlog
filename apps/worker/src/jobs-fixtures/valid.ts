import type { JobDefinition } from "../jobs.js";

// A normal job: create() returns a ticker that reports a fixed count.
export const job: JobDefinition = {
  name: "fixture.valid",
  create: () => async () => 7,
};
