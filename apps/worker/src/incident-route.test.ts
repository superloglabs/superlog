import assert from "node:assert/strict";
import test from "node:test";
import { buildIncidentUrl } from "./incident-route.js";

test("buildIncidentUrl includes the owning org and project slugs", () => {
  assert.equal(
    buildIncidentUrl("https://superlog.sh/", {
      orgSlug: "superlog",
      projectSlug: "demo-project",
      incidentId: "4b44c317-0d30-4c53-8938-9e1970a50cc5",
    }),
    "https://superlog.sh/org/superlog/project/demo-project/incidents/4b44c317-0d30-4c53-8938-9e1970a50cc5",
  );
});
