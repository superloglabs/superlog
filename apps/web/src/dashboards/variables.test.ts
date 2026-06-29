import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardVariable } from "./types.ts";
import {
  defaultVariableValues,
  isVariableRef,
  resolveAttrsWithVariables,
  resolveVariableRefs,
} from "./variables.ts";

const vars: DashboardVariable[] = [
  { name: "env", options: ["prod", "staging"], defaultValue: "prod" },
  { name: "region", options: ["us", "eu"] },
];

test("defaultVariableValues uses defaultValue, else first option, else empty", () => {
  assert.deepEqual(defaultVariableValues(vars), { env: "prod", region: "us" });
  assert.deepEqual(defaultVariableValues([{ name: "free", options: [] }]), { free: "" });
});

test("resolveVariableRefs substitutes $name and ${name} tokens", () => {
  const values = { env: "prod" };
  assert.equal(resolveVariableRefs("$env", values), "prod");
  assert.equal(resolveVariableRefs("${env}", values), "prod");
  assert.equal(resolveVariableRefs("team-$env-1", values), "team-prod-1");
});

test("resolveVariableRefs leaves unknown variables untouched", () => {
  assert.equal(resolveVariableRefs("$missing", { env: "prod" }), "$missing");
  assert.equal(resolveVariableRefs("plain", { env: "prod" }), "plain");
});

test("isVariableRef detects a bare variable token", () => {
  assert.equal(isVariableRef("$env"), true);
  assert.equal(isVariableRef("${env}"), true);
  assert.equal(isVariableRef("prod"), false);
  assert.equal(isVariableRef("team-$env"), false); // embedded, not bare
});

test("resolveAttrsWithVariables substitutes values and preserves key/op", () => {
  const resolved = resolveAttrsWithVariables(
    [
      { key: "deployment.environment", value: "$env", op: "eq" },
      { key: "service.name", value: "checkout" },
    ],
    { env: "staging" },
  );
  assert.deepEqual(resolved, [
    { key: "deployment.environment", value: "staging", op: "eq" },
    { key: "service.name", value: "checkout" },
  ]);
});

test("resolveAttrsWithVariables is a no-op when there are no values", () => {
  const attrs = [{ key: "service.name", value: "checkout" }];
  assert.deepEqual(resolveAttrsWithVariables(attrs, {}), attrs);
  assert.deepEqual(resolveAttrsWithVariables(undefined, { env: "prod" }), undefined);
});
