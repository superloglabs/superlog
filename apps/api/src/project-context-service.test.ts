import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { clampProjectContext, PROJECT_CONTEXT_MAX_LEN } = await import(
  "./project-context-service.js"
);

test("clampProjectContext clamps to the max length", () => {
  assert.equal(clampProjectContext("x".repeat(PROJECT_CONTEXT_MAX_LEN + 100)).length, 8000);
});

test("clampProjectContext leaves short strings untouched", () => {
  assert.equal(clampProjectContext("Checkout is a Next.js app on ECS."), "Checkout is a Next.js app on ECS.");
  assert.equal(clampProjectContext(""), "");
});
