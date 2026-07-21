import assert from "node:assert/strict";
import test from "node:test";
import { surfaceForPath } from "./entry-surface.ts";

test("marketing and product URLs boot independent client surfaces", () => {
  for (const path of [
    "/",
    "/pricing",
    "/blog",
    "/blog/update",
    "/team",
    "/missing-page",
    "/application",
    "/activation",
    "/designer",
  ]) {
    assert.equal(surfaceForPath(path), "marketing", path);
  }

  for (const path of [
    "/app",
    "/app/org/acme/project/default/incidents",
    "/org/acme/project/default/incidents",
    "/activate",
    "/accept-invitation",
    "/oauth/consent",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/settings",
    "/connect/vercel",
    "/feedback/pr/acme/repo/1",
    "/design",
    "/explore",
    "/explore/traces",
    "/incidents",
    "/incidents/incident-1",
    "/issues",
    "/issues/incident-1",
    "/alerts",
    "/alerts/alert-1",
    "/dashboards",
    "/dashboards/dashboard-1",
    "/anomaly-scanner",
    "/anomaly-scanner/scans/scan-1",
  ]) {
    assert.equal(surfaceForPath(path), "product", path);
  }
});

test("the legacy GitHub installation callback still boots the product surface", () => {
  assert.equal(surfaceForPath("/", "?installation_id=123&state=signed"), "product");
  assert.equal(surfaceForPath("/", "?installation_id=123"), "marketing");
});

test("legacy root OAuth callback markers still boot the product surface", () => {
  for (const search of ["?gh=done", "?gh=error", "?slack=installed", "?slack=error"]) {
    assert.equal(surfaceForPath("/", search), "product", search);
  }
});
