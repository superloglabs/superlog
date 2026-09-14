import assert from "node:assert/strict";
import { test } from "node:test";
import { getClickhouseConfig } from "./config.js";

test("getClickhouseConfig defaults database to superlog", () => {
  const config = getClickhouseConfig({});
  assert.equal(config.database, "superlog");
  assert.equal(config.url, "http://localhost:8123");
  assert.equal(config.username, "default");
  assert.equal(config.password, "");
});

test("getClickhouseConfig accepts CLICKHOUSE_DB", () => {
  const config = getClickhouseConfig({
    CLICKHOUSE_DB: "custom-db",
  });
  assert.equal(config.database, "custom-db");
});

test("getClickhouseConfig prioritizes CLICKHOUSE_DATABASE over CLICKHOUSE_DB", () => {
  const config = getClickhouseConfig({
    CLICKHOUSE_DATABASE: "db-one",
    CLICKHOUSE_DB: "db-two",
  });
  assert.equal(config.database, "db-one");
});

test("getClickhouseConfig respects URL, user, and password overrides", () => {
  const config = getClickhouseConfig({
    CLICKHOUSE_URL: "http://clickhouse:8123",
    CLICKHOUSE_USER: "admin",
    CLICKHOUSE_PASSWORD: "secret-password",
  });
  assert.equal(config.url, "http://clickhouse:8123");
  assert.equal(config.username, "admin");
  assert.equal(config.password, "secret-password");
});
