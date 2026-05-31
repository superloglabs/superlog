import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  aggregateLogIssueActivity,
  aggregateTraceIssueActivity,
} from "./issue-activity-backfill.js";

test("aggregateTraceIssueActivity hashes trace exception groups and sums counts by day", () => {
  const rows = [
    {
      project_id: "project-1",
      day: "2026-05-25",
      exc_type: "Error",
      exc_message: "boom 123",
      exc_stack: "Error: boom\n    at fail (apps/api/src/foo.ts:10:2)",
      c: "2",
    },
    {
      project_id: "project-1",
      day: "2026-05-25",
      exc_type: "Error",
      exc_message: "boom 456",
      exc_stack: "Error: boom\n    at fail (apps/api/src/foo.ts:10:2)",
      c: 3,
    },
  ];

  const aggregates = aggregateTraceIssueActivity(rows);

  assert.equal(aggregates.length, 1);
  const aggregate = aggregates[0];
  assert.ok(aggregate);
  assert.equal(aggregate.project_id, "project-1");
  assert.equal(aggregate.day, "2026-05-25");
  assert.equal(aggregate.event_count, 5);
  assert.equal(aggregate.fingerprint.length, 16);
});

test("aggregateLogIssueActivity hashes error log groups and keeps distinct fingerprints separate", () => {
  const aggregates = aggregateLogIssueActivity([
    {
      project_id: "project-1",
      day: "2026-05-25",
      service: "api",
      severity: "ERROR",
      body: "request failed for project 123",
      exc_type: "ForbiddenError",
      exc_stack: "",
      c: 2,
    },
    {
      project_id: "project-1",
      day: "2026-05-25",
      service: "api",
      severity: "ERROR",
      body: "database failed",
      exc_type: "DatabaseError",
      exc_stack: "",
      c: 1,
    },
  ]);

  assert.equal(aggregates.length, 2);
  assert.deepEqual(aggregates.map((row) => row.event_count).sort(), [1, 2]);
});
