import assert from "node:assert/strict";
import { test } from "node:test";
import { planSentryProjectSelection } from "./project-selection.js";

test("installs the only accessible Sentry project without another user step", () => {
  assert.deepEqual(
    planSentryProjectSelection([{ id: "1", slug: "storefront", name: "Storefront" }]),
    { kind: "automatic", project: { id: "1", slug: "storefront", name: "Storefront" } },
  );
});

test("asks the user to choose when the selected Sentry organization has several projects", () => {
  const projects = [
    { id: "1", slug: "storefront", name: "Storefront" },
    { id: "2", slug: "worker", name: "Worker" },
  ];
  assert.deepEqual(planSentryProjectSelection(projects), { kind: "choose", projects });
});

test("rejects a Sentry organization with no accessible projects", () => {
  assert.throws(() => planSentryProjectSelection([]), /no accessible projects/i);
});
