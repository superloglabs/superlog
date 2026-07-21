import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sentryProjectEndpoints } from "./api.js";

test("Sentry settings requests stay in the selected project", () => {
  assert.deepEqual(sentryProjectEndpoints("project-2"), {
    installation: "/api/projects/project-2/sentry/installation",
    installUrl: "/api/projects/project-2/sentry/install-url",
    uninstall: "/api/projects/project-2/sentry/uninstall",
  });
});
