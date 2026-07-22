import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sentryProjectEndpoints } from "./api.js";

test("Sentry settings requests stay in the selected project", () => {
  const endpoints = sentryProjectEndpoints("project-2");
  assert.equal(endpoints.installation, "/api/projects/project-2/sentry/installation");
  assert.equal(endpoints.installUrl, "/api/projects/project-2/sentry/install-url");
  assert.equal(endpoints.importOpenIssues, "/api/projects/project-2/sentry/import-open-issues");
  assert.equal(endpoints.uninstall, "/api/projects/project-2/sentry/uninstall");
  assert.equal(
    endpoints.authorization("authorization-1"),
    "/api/projects/project-2/sentry/authorizations/authorization-1",
  );
  assert.equal(
    endpoints.connectAuthorization("authorization-1"),
    "/api/projects/project-2/sentry/authorizations/authorization-1/connect",
  );
});
