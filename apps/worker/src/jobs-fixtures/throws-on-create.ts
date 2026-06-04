import type { JobDefinition } from "../jobs.js";

// create() throws. A single broken job must not take down worker boot — the
// loader logs and skips it, and the rest still load.
export const job: JobDefinition = {
  name: "fixture.throws",
  create: () => {
    throw new Error("boom");
  },
};
