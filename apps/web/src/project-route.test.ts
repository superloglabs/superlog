import assert from "node:assert/strict";
import test from "node:test";
import {
  appLocationFromProjectRoute,
  appPathFromProjectRoute,
  buildProjectPath,
  canonicalProjectLocation,
} from "./project-route.ts";

test("buildProjectPath creates shareable incident URLs with org and project slugs", () => {
  assert.equal(
    buildProjectPath(
      { orgSlug: "superlog", projectSlug: "demo-project" },
      "/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
    ),
    "/org/superlog/project/demo-project/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
  );
});

test("appPathFromProjectRoute exposes the incident route inside a scoped URL", () => {
  assert.equal(
    appPathFromProjectRoute(
      "/org/superlog/project/demo-project/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
    ),
    "/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
  );
  assert.equal(appPathFromProjectRoute("/incidents/incident-1"), "/incidents/incident-1");
});

test("all project pages have canonical org and project URLs", () => {
  const slugs = { orgSlug: "superlog", projectSlug: "demo-project" };
  const appPaths = [
    "/explore/logs",
    "/incidents/incident-1",
    "/issues/issue-1",
    "/alerts/alert-1",
    "/dashboards/dashboard-1",
    "/settings?scope=project&section=integrations",
  ];

  for (const appPath of appPaths) {
    assert.equal(buildProjectPath(slugs, appPath), `/org/superlog/project/demo-project${appPath}`);
  }
});

test("the project root is the canonical overview URL", () => {
  const scopedRoot = "/org/superlog/project/demo-project";

  assert.equal(
    buildProjectPath({ orgSlug: "superlog", projectSlug: "demo-project" }, "/"),
    scopedRoot,
  );
  assert.equal(appPathFromProjectRoute(scopedRoot), "/");
  assert.equal(appPathFromProjectRoute(`${scopedRoot}/`), "/");
});

test("canonical project navigation preserves search and hash state", () => {
  assert.deepEqual(
    canonicalProjectLocation(
      { orgSlug: "superlog", projectSlug: "demo-project" },
      {
        pathname: "/explore/logs",
        search: "?service=api&severity=error",
        hash: "#selected",
      },
    ),
    {
      pathname: "/org/superlog/project/demo-project/explore/logs",
      search: "?service=api&severity=error",
      hash: "#selected",
    },
  );
});

test("scoped browser locations are translated back to app routes", () => {
  assert.deepEqual(
    appLocationFromProjectRoute({
      pathname: "/org/superlog/project/demo-project/dashboards/dashboard-1",
      search: "?range=1h",
      hash: "#latency",
    }),
    {
      pathname: "/dashboards/dashboard-1",
      search: "?range=1h",
      hash: "#latency",
    },
  );
});
