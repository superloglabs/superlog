import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUsageCountQuery } from "./usage-count-query.js";

test("log usage counts preserve precise bounds while pruning by TimestampTime", () => {
  const query = buildUsageCountQuery("logs");

  assert.match(query, /Timestamp > \{after:DateTime64\(9\)\}/);
  assert.match(query, /Timestamp <= \{until:DateTime64\(9\)\}/);
  assert.match(query, /TimestampTime >= \{after:DateTime64\(9\)\} - INTERVAL 1 SECOND/);
  assert.match(query, /TimestampTime <= \{until:DateTime64\(9\)\}/);
});
