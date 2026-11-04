import assert from "node:assert/strict";
import test from "node:test";
import { CLICKHOUSE_DB_FALLBACK, resolveClickhouseConfig } from "./config.js";

test("defaults match the documented local stack", () => {
  assert.deepEqual(resolveClickhouseConfig({}), {
    url: "http://localhost:8123",
    username: "default",
    password: "",
    database: CLICKHOUSE_DB_FALLBACK,
  });
});

test("CLICKHOUSE_DB wins over the legacy CLICKHOUSE_DATABASE alias", () => {
  assert.equal(
    resolveClickhouseConfig({ CLICKHOUSE_DB: "from_db", CLICKHOUSE_DATABASE: "from_database" })
      .database,
    "from_db",
  );
});

test("the legacy CLICKHOUSE_DATABASE alias still resolves when CLICKHOUSE_DB is unset", () => {
  assert.equal(resolveClickhouseConfig({ CLICKHOUSE_DATABASE: "legacy" }).database, "legacy");
});

test("credentials and URL come from the standard variables", () => {
  assert.deepEqual(
    resolveClickhouseConfig({
      CLICKHOUSE_URL: "https://ch.example:8443",
      CLICKHOUSE_USER: "reader",
      CLICKHOUSE_PASSWORD: "secret",
    }),
    {
      url: "https://ch.example:8443",
      username: "reader",
      password: "secret",
      database: CLICKHOUSE_DB_FALLBACK,
    },
  );
});
