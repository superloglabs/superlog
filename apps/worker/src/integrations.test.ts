import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { REVYL_INTEGRATION } from "./integrations.js";

test("revyl_validate_yaml description documents the required build.name field", () => {
  const op = REVYL_INTEGRATION.operations.find((o) => o.name === "revyl_validate_yaml");
  assert.ok(op, "revyl_validate_yaml operation should exist");
  assert.match(
    op.description,
    /build/,
    "revyl_validate_yaml description should mention 'build' section requirement",
  );
  assert.match(
    op.description,
    /name/,
    "revyl_validate_yaml description should mention 'name' field requirement",
  );
});

test("revyl_create_test_from_yaml description documents the required build.name field", () => {
  const op = REVYL_INTEGRATION.operations.find((o) => o.name === "revyl_create_test_from_yaml");
  assert.ok(op, "revyl_create_test_from_yaml operation should exist");
  assert.match(
    op.description,
    /build/,
    "revyl_create_test_from_yaml description should mention 'build' section requirement",
  );
  assert.match(
    op.description,
    /name/,
    "revyl_create_test_from_yaml description should mention 'name' field requirement",
  );
});
