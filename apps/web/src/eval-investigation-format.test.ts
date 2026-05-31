import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describeRubric,
  summarizeTelemetryRows,
  telemetryDisplayRow,
} from "./eval-investigation-format.ts";

test("describeRubric turns the investigation rubric into reviewable sections", () => {
  const sections = describeRubric({
    review: {
      title: {
        golden: "Members see 'Unauthorized' when navigating to projects in a non-active org",
        good: "Names the Unauthorized symptom and non-active-org project navigation.",
        avoid: "Generic 403 framing or PR-style Allow wording.",
      },
      root_cause: { good: "Compare project.orgId to active org instead of membership." },
    },
    passing: { title: 0.75, summary: 0.8, root_cause: 0.8 },
    title: {
      expected: "Members see 'Unauthorized' when navigating to projects in a non-active org",
      required_concepts: [
        ["members"],
        ["see", "get"],
        ["Unauthorized"],
        ["navigating", "accessing"],
        ["project"],
        ["active org", "cross-org"],
      ],
      forbidden_concepts: ["403", "Allow members", "Better Auth session"],
    },
    summary: {
      expected: "Users get an Unauthorized error outside the active org.",
      required_concepts: [["Unauthorized"], ["active org"], ["membership"]],
      forbidden_concepts: ["403"],
    },
    root_cause: {
      causal_mechanism: "requireProjectAccess checks active org instead of org_members.",
      required_concepts: [["requireProjectAccess"], ["org_members", "membership"]],
      required_evidence: ["project.authorize", "forbidden"],
    },
    fix: {
      acceptable_directions: ["org_members lookup"],
      unacceptable_directions: ["disable the authorization check"],
    },
    pr_title: {
      expected: "[superlog] Allow members to access projects outside the active org",
      required_concepts: [["[superlog]"], ["members"], ["projects"], ["active org"]],
      forbidden_concepts: ["Fix API returns 403"],
    },
    pr_body: {
      required_concepts: [["# Summary"], ["Unauthorized"], ["Incident on Superlog"]],
      forbidden_concepts: ["## Motivation", "## Testing guidelines"],
    },
  });

  assert.deepEqual(
    sections.map((s) => s.title),
    [
      "Review expectations",
      "Passing thresholds",
      "Title grading",
      "Summary grading",
      "Root cause grading",
      "Fix grading",
      "PR title grading",
      "PR body grading",
    ],
  );
  assert.deepEqual(sections[2]?.lines.find((l) => l.label === "Required concepts")?.value, [
    "members",
    "see / get",
    "Unauthorized",
    "navigating / accessing",
    "project",
    "active org / cross-org",
  ]);
  assert.equal(
    sections[3]?.lines.find((l) => l.label === "Expected")?.value,
    "Users get an Unauthorized error outside the active org.",
  );
  assert.equal(
    sections[5]?.lines.find((l) => l.label === "Unacceptable directions")?.value[0],
    "disable the authorization check",
  );
  assert.equal(
    sections[6]?.lines.find((l) => l.label === "Expected")?.value,
    "[superlog] Allow members to access projects outside the active org",
  );
});

test("summarizeTelemetryRows pulls out services, routes, errors, and notable spans", () => {
  const rows = [
    {
      Timestamp: "2026-05-27 13:57:55.172000000",
      ServiceName: "superlog-api",
      SpanName: "project.authorize",
      Duration: 910020411,
      StatusCode: "Error",
      StatusMessage: "forbidden",
      SpanAttributes: { "tenant.project_id": "project-1" },
      "Events.Attributes": [
        {
          "exception.message": "forbidden",
          "exception.type": "Error",
          "exception.stacktrace": "Error: forbidden\n    at index.ts:985:47",
        },
      ],
    },
    {
      Timestamp: "2026-05-27 13:57:55.096000000",
      ServiceName: "superlog-api",
      SpanName: "POST",
      Duration: 986809278,
      StatusCode: "Unset",
      SpanAttributes: {
        "http.route": "/api/projects/:projectId/explore/metric-series",
        "http.response.status_code": "403",
      },
      "Events.Attributes": [],
    },
    {
      Timestamp: "2026-05-27 13:57:54.853000000",
      ServiceName: "@superlog/web",
      SpanName: "HTTP POST",
      Duration: 1233000000,
      StatusCode: "Unset",
      SpanAttributes: {
        "http.url": "https://api.superlog.sh/api/projects/project-1/explore/metric-series",
        "http.status_code": "403",
      },
      "Events.Attributes": [],
    },
  ];

  const summary = summarizeTelemetryRows(rows);

  assert.deepEqual(summary.services, [
    { name: "superlog-api", count: 2 },
    { name: "@superlog/web", count: 1 },
  ]);
  assert.equal(summary.routes[0]?.route, "/api/projects/:projectId/explore/metric-series");
  assert.equal(summary.exceptions[0]?.message, "forbidden");
  assert.equal(summary.exceptions[0]?.stackTop, "Error: forbidden");
  assert.equal(summary.notableRows.length, 3);
  assert.equal(summary.notableRows[0]?.durationMs, "910.0");
});

test("summarizeTelemetryRows treats numeric HTTP statuses as notable 4xx rows", () => {
  const summary = summarizeTelemetryRows([
    {
      Timestamp: "2026-05-27 13:57:55.096000000",
      ServiceName: "superlog-api",
      SpanName: "GET",
      Duration: 986809278,
      StatusCode: "Unset",
      SpanAttributes: {
        "http.route": "/api/projects/:projectId",
        "http.response.status_code": 403,
      },
      "Events.Attributes": [],
    },
  ]);

  assert.equal(summary.notableRows.length, 1);
  assert.equal(summary.notableRows[0]?.httpStatus, "403");
});

test("telemetryDisplayRow returns null for non-object rows", () => {
  assert.equal(telemetryDisplayRow("not a row"), null);
});
