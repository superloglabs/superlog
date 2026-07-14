import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectDigestEndpoints } from "./api.js";

test("digest settings and test delivery stay within the selected project", () => {
  assert.deepEqual(projectDigestEndpoints("project-2"), {
    settings: "/api/projects/project-2/digest",
    runNow: "/api/projects/project-2/digest/run-now",
  });
});
