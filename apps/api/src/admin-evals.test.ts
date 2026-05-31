import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadInvestigationFixtureDetail, loadInvestigationFixtures } from "./admin-evals.js";

function writeFixture(
  root: string,
  slug: string,
  fixture: unknown,
  extras: { groundTruth?: string; rubric?: string } = {},
): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture, null, 2));
  if (extras.groundTruth !== undefined)
    writeFileSync(join(dir, "ground_truth.md"), extras.groundTruth);
  if (extras.rubric !== undefined) writeFileSync(join(dir, "rubric.json"), extras.rubric);
}

test("investigation loader returns fixture metadata and skips template/readme", () => {
  const root = mkdtempSync(join(tmpdir(), "superlog-investigations-test-"));
  try {
    writeFixture(
      root,
      "2026-04-27-cross-org-project-403",
      {
        schema_version: 1,
        slug: "2026-04-27-cross-org-project-403",
        incident: {
          id: "32d0ffe3-c644-4823-a60d-b66d0eaf1444",
          project_id: "b925b1df-5b78-43c8-a816-6f00afb174af",
          org_id: "4be29cb0-02d7-42d9-9d16-b8e47326d6ba",
          title: "API returns 403 to members accessing projects in a non-active org",
          service: "@superlog/api",
          window: { since: "2026-04-27T06:13:57.553Z", until: "2026-05-27T13:51:06.826Z" },
        },
        code: { artifact: "code/worktree.tar.gz" },
        telemetry: { files: [{ table: "otel_traces", path: "telemetry/otel_traces.jsonl" }] },
        ground_truth: "ground_truth.md",
        rubric: "rubric.json",
      },
      {
        groundTruth: "SECRET ANSWER: drop the active-org check, use org_members lookup",
        rubric: JSON.stringify({ title: { expected: "SECRET RUBRIC EXPECTED TITLE" } }),
      },
    );

    // The _template scaffold and the README must never appear as a case.
    writeFixture(root, "_template", {
      schema_version: 1,
      slug: "replace-me",
      incident: { id: "0", project_id: "0", org_id: "0", title: "Replace me", service: null },
      ground_truth: "ground_truth.md",
      rubric: "rubric.json",
    });
    writeFileSync(join(root, "README.md"), "# Investigation Evals\n");

    const result = loadInvestigationFixtures(root);

    assert.equal(result.readError, null);
    assert.equal(result.fixtures.length, 1, "skips _template and README");

    const fx = result.fixtures[0];
    assert.ok(fx, "fixture present");
    assert.equal(fx.slug, "2026-04-27-cross-org-project-403");
    assert.equal(fx.incidentId, "32d0ffe3-c644-4823-a60d-b66d0eaf1444");
    assert.equal(fx.title, "API returns 403 to members accessing projects in a non-active org");
    assert.equal(fx.service, "@superlog/api");
    assert.equal(fx.window.since, "2026-04-27T06:13:57.553Z");
    assert.equal(fx.window.until, "2026-05-27T13:51:06.826Z");
    assert.deepEqual(fx.telemetryTables, ["otel_traces"]);
    assert.equal(fx.hasCode, true);
    assert.equal(fx.hasGroundTruth, true);
    assert.equal(fx.hasRubric, true);

    // The answer key must never cross the wire.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("SECRET ANSWER"), "ground_truth content must not leak");
    assert.ok(!serialized.includes("SECRET RUBRIC"), "rubric content must not leak");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("investigation loader reports a read error for a missing directory", () => {
  const result = loadInvestigationFixtures(join(tmpdir(), "does-not-exist-superlog-xyz"));
  assert.equal(result.fixtures.length, 0);
  assert.notEqual(result.readError, null);
});

function seedDetailFixture(root: string, slug: string): void {
  const dir = join(root, slug);
  mkdirSync(join(dir, "postgres"), { recursive: true });
  mkdirSync(join(dir, "telemetry"), { recursive: true });
  mkdirSync(join(dir, "code"), { recursive: true });
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      schema_version: 1,
      slug,
      incident: {
        id: "inc-1",
        title: "API returns 403 to members accessing projects in a non-active org",
        service: "@superlog/api",
        window: { since: "2026-04-27T06:13:57.553Z", until: "2026-05-27T13:51:06.826Z" },
      },
      code: { artifact: "code/worktree.tar.gz" },
      telemetry: { files: [{ table: "otel_traces", path: "telemetry/otel_traces.jsonl" }] },
      ground_truth: "ground_truth.md",
      rubric: "rubric.json",
    }),
  );
  writeFileSync(
    join(dir, "ground_truth.md"),
    "# Ground Truth\n\nUse an org_members membership lookup.",
  );
  writeFileSync(join(dir, "rubric.json"), JSON.stringify({ title: { expected: "Allow members" } }));
  writeFileSync(join(dir, "postgres", "incident.json"), JSON.stringify([{ id: "inc-1" }]));
  // 120 rows so we can prove the sample is capped but the count is exact.
  const rows = Array.from({ length: 120 }, (_, i) => JSON.stringify({ SpanId: `span-${i}` }));
  writeFileSync(join(dir, "telemetry", "otel_traces.jsonl"), `${rows.join("\n")}\n`);
  writeFileSync(join(dir, "code", "worktree.tar.gz"), "fake-archive-bytes");
}

test("investigation detail returns ground truth, rubric, postgres, and capped telemetry", () => {
  const root = mkdtempSync(join(tmpdir(), "superlog-investigation-detail-"));
  try {
    seedDetailFixture(root, "2026-04-27-cross-org-project-403");
    const detail = loadInvestigationFixtureDetail("2026-04-27-cross-org-project-403", root);

    assert.ok(detail, "detail returned");
    assert.equal(detail.readError, null);
    assert.equal(detail.slug, "2026-04-27-cross-org-project-403");
    assert.equal(
      detail.incident.title,
      "API returns 403 to members accessing projects in a non-active org",
    );
    assert.match(detail.groundTruth ?? "", /org_members membership lookup/);
    assert.deepEqual(detail.rubric, { title: { expected: "Allow members" } });

    const pg = detail.postgres.find((p) => p.file === "incident.json");
    assert.ok(pg, "incident.json present");
    assert.deepEqual(pg.json, [{ id: "inc-1" }]);

    const tel = detail.telemetry[0];
    assert.ok(tel, "telemetry present");
    assert.equal(tel.table, "otel_traces");
    assert.equal(tel.rowCount, 120, "reports the true total");
    assert.equal(tel.sample.length, 50, "caps the sample");

    assert.ok(detail.code, "code artifact present");
    assert.equal(detail.code.artifact, "code/worktree.tar.gz");
    assert.ok(detail.code.bytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("investigation detail rejects slug path traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "superlog-investigation-traversal-"));
  try {
    seedDetailFixture(root, "real-slug");
    // A secret outside the investigations root that traversal must not reach.
    writeFileSync(join(root, "..", "secret-outside.txt"), "TOP SECRET");
    for (const evil of ["../secret-outside", "..", "foo/bar", "a/../../b", "."]) {
      const detail = loadInvestigationFixtureDetail(evil, root);
      assert.equal(detail, null, `traversal slug ${JSON.stringify(evil)} must be rejected`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, "..", "secret-outside.txt"), { force: true });
  }
});

test("investigation detail returns null for an unknown slug", () => {
  const root = mkdtempSync(join(tmpdir(), "superlog-investigation-unknown-"));
  try {
    const detail = loadInvestigationFixtureDetail("nope-not-here", root);
    assert.equal(detail, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
