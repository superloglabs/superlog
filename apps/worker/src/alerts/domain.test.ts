import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  alertEpisodeFingerprint,
  buildAlertIssueSample,
  buildIssueTitle,
  classifyFiringTransition,
  compare,
  deriveEvaluations,
  evaluationRange,
  moreSevereValue,
  serviceFromGroup,
} from "./domain.js";

test("compare honours gt and lt comparators", () => {
  assert.equal(compare(5, "gt", 4), true);
  assert.equal(compare(4, "gt", 4), false);
  assert.equal(compare(3, "lt", 4), true);
  assert.equal(compare(4, "lt", 4), false);
});

test("moreSevereValue keeps the worst value per comparator direction", () => {
  // gt alerts get worse as the value climbs → keep the max
  assert.equal(moreSevereValue(10, 25, "gt"), 25);
  assert.equal(moreSevereValue(25, 10, "gt"), 25);
  // lt alerts get worse as the value drops → keep the min
  assert.equal(moreSevereValue(10, 3, "lt"), 3);
  assert.equal(moreSevereValue(3, 10, "lt"), 3);
});

test("alertEpisodeFingerprint keys the issue to one episode", () => {
  assert.equal(
    alertEpisodeFingerprint("5e41fa44-173a-4a06-808c-0144c0f87dbb"),
    "alert-episode:5e41fa44-173a-4a06-808c-0144c0f87dbb",
  );
});

test("serviceFromGroup returns the group key only for service-grouped alerts", () => {
  assert.equal(serviceFromGroup("service.name", "api"), "api");
  assert.equal(serviceFromGroup("service", "api"), "api");
  assert.equal(serviceFromGroup("service.name", ""), null);
  assert.equal(serviceFromGroup("region", "us-east"), null);
  assert.equal(serviceFromGroup(null, "api"), null);
});

test("buildIssueTitle formats integer and float values and includes group when present", () => {
  const base = { name: "Errors", comparator: "gt" as const, threshold: 10 };
  assert.equal(buildIssueTitle(base, 12, ""), "Errors > 10 (observed=12)");
  assert.equal(buildIssueTitle(base, 12.345, ""), "Errors > 10 (observed=12.35)");
  assert.equal(
    buildIssueTitle({ ...base, comparator: "lt" }, 3.5, "checkout"),
    "Errors < 10 (observed=3.50) group=checkout",
  );
});

test("deriveEvaluations in per_group mode emits one result per group", () => {
  const alert = {
    groupMode: "per_group" as const,
    groupBy: "service.name",
    aggregation: "sum" as const,
    comparator: "gt" as const,
    threshold: 10,
  };
  const groups = new Map([
    ["api", 15],
    ["worker", 5],
  ]);
  const out = deriveEvaluations(alert, groups);
  assert.deepEqual(
    out.sort((a, b) => a.groupKey.localeCompare(b.groupKey)),
    [
      { groupKey: "api", value: 15, firing: true },
      { groupKey: "worker", value: 5, firing: false },
    ],
  );
});

test("deriveEvaluations in per_group mode without groupBy falls back to single", () => {
  const alert = {
    groupMode: "per_group" as const,
    groupBy: null,
    aggregation: "sum" as const,
    comparator: "gt" as const,
    threshold: 10,
  };
  const out = deriveEvaluations(alert, new Map([["", 20]]));
  assert.deepEqual(out, [{ groupKey: "", value: 20, firing: true }]);
});

test("deriveEvaluations in single mode sums across groups by default", () => {
  const alert = {
    groupMode: "single" as const,
    groupBy: "service.name",
    aggregation: "sum" as const,
    comparator: "gt" as const,
    threshold: 10,
  };
  const out = deriveEvaluations(
    alert,
    new Map([
      ["api", 7],
      ["worker", 4],
    ]),
  );
  assert.deepEqual(out, [{ groupKey: "", value: 11, firing: true }]);
});

test("deriveEvaluations in single mode averages across groups when aggregation is avg", () => {
  const alert = {
    groupMode: "single" as const,
    groupBy: "service.name",
    aggregation: "avg" as const,
    comparator: "gt" as const,
    threshold: 6,
  };
  const out = deriveEvaluations(
    alert,
    new Map([
      ["api", 4],
      ["worker", 10],
    ]),
  );
  assert.deepEqual(out, [{ groupKey: "", value: 7, firing: true }]);
});

test("deriveEvaluations with empty groups emits a single 0-value result", () => {
  const alert = {
    groupMode: "single" as const,
    groupBy: null,
    aggregation: "avg" as const,
    comparator: "gt" as const,
    threshold: 1,
  };
  const out = deriveEvaluations(alert, new Map());
  assert.deepEqual(out, [{ groupKey: "", value: 0, firing: false }]);
});

test("classifyFiringTransition covers all combinations", () => {
  assert.equal(classifyFiringTransition(null, true), "new_firing");
  assert.equal(classifyFiringTransition("ok", true), "new_firing");
  assert.equal(classifyFiringTransition("firing", true), "still_firing");
  assert.equal(classifyFiringTransition("firing", false), "recovered");
  assert.equal(classifyFiringTransition("ok", false), "still_ok");
  assert.equal(classifyFiringTransition(null, false), "still_ok");
});

test("buildAlertIssueSample carries service only for service-grouped alerts", () => {
  const alert = {
    name: "Latency",
    comparator: "gt" as const,
    threshold: 100,
    groupBy: "service.name",
  };
  const sample = buildAlertIssueSample(alert, 150, "api", new Date("2026-05-23T10:00:00Z"));
  assert.equal(sample.service, "api");
  assert.equal(sample.kind, "log");
  assert.equal(sample.exceptionType, "AlertFired");
  assert.equal(sample.message, "Latency > 100 (observed=150) group=api");
  assert.equal(sample.seenAt, "2026-05-23T10:00:00.000Z");

  const sample2 = buildAlertIssueSample(
    { ...alert, groupBy: "region" } satisfies Partial<schema.Alert> as Pick<
      schema.Alert,
      "name" | "comparator" | "threshold" | "groupBy"
    >,
    150,
    "us-east",
    new Date("2026-05-23T10:00:00Z"),
  );
  assert.equal(sample2.service, null);
});

test("evaluationRange spans windowMinutes ending at now", () => {
  const now = new Date("2026-05-23T10:00:00Z");
  const range = evaluationRange(now, 5);
  assert.equal(range.until, "2026-05-23T10:00:00.000Z");
  assert.equal(range.since, "2026-05-23T09:55:00.000Z");
});
