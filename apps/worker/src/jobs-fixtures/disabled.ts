import type { JobDefinition } from "../jobs.js";

// A job that opts out at create() time (e.g. a required env var / API key is
// absent). The loader must skip it rather than register a no-op ticker.
export const job: JobDefinition = {
  name: "fixture.disabled",
  create: () => null,
};
