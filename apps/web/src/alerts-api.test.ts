import assert from "node:assert/strict";
import test from "node:test";
import { alertSeriesPath } from "./alerts/series-path.ts";

test("alertSeriesPath preserves an explicitly empty group key", () => {
  assert.equal(
    alertSeriesPath("project-1", "alert-1", ""),
    "/api/projects/project-1/alerts/alert-1/series?groupKey=",
  );
  assert.equal(
    alertSeriesPath("project-1", "alert-1"),
    "/api/projects/project-1/alerts/alert-1/series",
  );
});
