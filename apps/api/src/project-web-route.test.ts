import assert from "node:assert/strict";
import test from "node:test";
import { buildAppWebUrl, buildIncidentWebUrl } from "./project-web-route.js";

test("buildAppWebUrl keeps product destinations under the app surface", () => {
  assert.equal(buildAppWebUrl("https://superlog.sh/"), "https://superlog.sh/app");
  assert.equal(
    buildAppWebUrl("https://superlog.sh", "/settings?linear=installed"),
    "https://superlog.sh/app/settings?linear=installed",
  );
  assert.equal(
    buildAppWebUrl("https://superlog.sh", "?cloudflare=installed"),
    "https://superlog.sh/app?cloudflare=installed",
  );
});

test("buildIncidentWebUrl creates an encoded URL under the app surface", () => {
  assert.equal(
    buildIncidentWebUrl("https://superlog.sh/", {
      orgSlug: "acme & co",
      projectSlug: "checkout/api",
      incidentId: "incident 1",
    }),
    "https://superlog.sh/app/org/acme%20%26%20co/project/checkout%2Fapi/incidents/incident%201",
  );
});
