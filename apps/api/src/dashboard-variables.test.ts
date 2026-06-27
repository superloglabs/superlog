import assert from "node:assert/strict";
import { test } from "node:test";

// dashboards-service.ts transitively imports the db client, which throws at
// import time without a connection string. These schema tests never open a
// socket (postgres-js connects lazily), so a dummy URL is enough. Same pattern
// as alerts-service.test.ts / demo.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { dashboardUpdateSchema, dashboardVariablesSchema } = await import("./dashboards-service.js");

test("dashboard variables accept a name, options, and default", () => {
  const parsed = dashboardVariablesSchema.parse([
    {
      name: "env",
      label: "Environment",
      options: ["prod", "staging"],
      defaultValue: "prod",
      attributeKey: "deployment.environment",
    },
  ]);
  assert.equal(parsed[0]?.name, "env");
  assert.deepEqual(parsed[0]?.options, ["prod", "staging"]);
  assert.equal(parsed[0]?.defaultValue, "prod");
});

test("variable names must be reference-safe identifiers", () => {
  assert.throws(() => dashboardVariablesSchema.parse([{ name: "my var", options: [] }]));
  assert.throws(() => dashboardVariablesSchema.parse([{ name: "1env", options: [] }]));
  assert.throws(() => dashboardVariablesSchema.parse([{ name: "$env", options: [] }]));
  // a bare letter-led identifier is fine
  assert.doesNotThrow(() => dashboardVariablesSchema.parse([{ name: "env_2", options: [] }]));
});

test("variable names must be unique within a dashboard", () => {
  assert.throws(
    () =>
      dashboardVariablesSchema.parse([
        { name: "env", options: ["prod"] },
        { name: "env", options: ["staging"] },
      ]),
    /duplicate/i,
  );
});

test("a set defaultValue must be one of the options", () => {
  assert.throws(
    () => dashboardVariablesSchema.parse([{ name: "env", options: ["prod"], defaultValue: "qa" }]),
    /default/i,
  );
  // empty options means the value is free-form, so any default is allowed
  assert.doesNotThrow(() =>
    dashboardVariablesSchema.parse([{ name: "env", options: [], defaultValue: "anything" }]),
  );
});

test("dashboard update accepts an optional variables list", () => {
  const parsed = dashboardUpdateSchema.parse({
    name: "Ops",
    variables: [{ name: "env", options: ["prod", "staging"], defaultValue: "prod" }],
  });
  assert.equal(parsed.variables?.length, 1);
  // name-only update still works (variables is optional)
  assert.deepEqual(dashboardUpdateSchema.parse({ name: "Ops" }).variables, undefined);
});
