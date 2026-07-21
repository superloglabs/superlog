import assert from "node:assert/strict";
import test from "node:test";
import {
  appLocationFromProjectRoute,
  appPathFromProjectRoute,
  buildProjectPath,
  canonicalProjectLocation,
  legacyProductLocation,
} from "./project-route.ts";

test("buildProjectPath creates shareable incident URLs with org and project slugs", () => {
  assert.equal(
    buildProjectPath(
      { orgSlug: "superlog", projectSlug: "demo-project" },
      "/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
    ),
    "/app/org/superlog/project/demo-project/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
  );
});

test("appPathFromProjectRoute exposes the incident route inside a scoped URL", () => {
  assert.equal(
    appPathFromProjectRoute(
      "/app/org/superlog/project/demo-project/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
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
    assert.equal(
      buildProjectPath(slugs, appPath),
      `/app/org/superlog/project/demo-project${appPath}`,
    );
  }
});

test("the project root is the canonical overview URL", () => {
  const scopedRoot = "/app/org/superlog/project/demo-project";

  assert.equal(
    buildProjectPath({ orgSlug: "superlog", projectSlug: "demo-project" }, "/"),
    scopedRoot,
  );
  assert.equal(appPathFromProjectRoute(scopedRoot), "/");
  assert.equal(appPathFromProjectRoute(`${scopedRoot}/`), "/");
});

test("unscoped app entry URLs are translated into project-local paths", () => {
  assert.equal(appPathFromProjectRoute("/app"), "/");
  assert.equal(appPathFromProjectRoute("/app/"), "/");
  assert.equal(appPathFromProjectRoute("/app/settings"), "/settings");
});

test("legacy product entries move under /app without losing query or hash state", () => {
  assert.equal(
    legacyProductLocation({
      pathname: "/settings",
      search: "?scope=org&section=billing",
      hash: "#plan",
    }),
    "/app/settings?scope=org&section=billing#plan",
  );
  assert.equal(
    legacyProductLocation({ pathname: "/", search: "?slack=installed", hash: "" }),
    "/app?slack=installed",
  );
});

test("the app entry URL canonicalizes to the active project root", () => {
  assert.equal(
    canonicalProjectLocation(
      { orgSlug: "superlog", projectSlug: "demo-project" },
      { pathname: "/app", search: "", hash: "" },
    ).pathname,
    "/app/org/superlog/project/demo-project",
  );
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
      pathname: "/app/org/superlog/project/demo-project/explore/logs",
      search: "?service=api&severity=error",
      hash: "#selected",
    },
  );
});

test("canonical project navigation replaces an existing project scope", () => {
  assert.deepEqual(
    canonicalProjectLocation(
      { orgSlug: "new-org", projectSlug: "new-project" },
      {
        pathname: "/org/old-org/project/old-project/incidents/incident-1",
        search: "?tab=timeline",
        hash: "#event-1",
      },
    ),
    {
      pathname: "/app/org/new-org/project/new-project/incidents/incident-1",
      search: "?tab=timeline",
      hash: "#event-1",
    },
  );
});

test("scoped browser locations are translated back to app routes", () => {
  assert.deepEqual(
    appLocationFromProjectRoute({
      pathname: "/app/org/superlog/project/demo-project/dashboards/dashboard-1",
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
