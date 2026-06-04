// A module in the jobs dir that does not export a `job`. The loader must skip
// it (and warn) rather than crash.
export const notAJob = 1;
