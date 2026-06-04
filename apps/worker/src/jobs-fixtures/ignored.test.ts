import type { JobDefinition } from "../jobs.js";

// A `*.test.ts` file that happens to export a job. The loader must NOT pick it
// up — test files are not jobs. (Intentionally registers no node:test cases so
// it is inert if a future glob test runner ever discovers it.)
export const job: JobDefinition = {
  name: "fixture.ignored-test",
  create: () => async () => 1,
};
