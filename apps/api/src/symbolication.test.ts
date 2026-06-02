import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { DB, IssueSample } from "@superlog/db";
import type * as schema from "@superlog/db/schema";
import {
  findSourceMapArtifact,
  symbolicateIssueSample,
  symbolicateStacktraceWithArtifact,
  symbolicationAttrsForSample,
} from "./symbolication.js";

const sourceMap = JSON.stringify({
  version: 3,
  file: "index.android.bundle",
  sources: ["app/index.tsx"],
  names: ["HomeScreen"],
  mappings: "AAAAA",
});

const artifact = {
  id: "artifact-1",
  projectId: "project-1",
  platform: "android",
  release: "juno@1.2.3",
  dist: null,
  debugId: null,
  bundleFile: "index.android.bundle",
  mapFile: "index.android.bundle.map",
  sourceMapHash: "a".repeat(64),
  sourceMapBytes: Buffer.byteLength(sourceMap),
  storageBucket: "source-map-bucket",
  storageKey: "source-maps/project-1/android/hash.map.gz",
  contentEncoding: "gzip",
  uploadedByOrgApiKeyId: null,
  createdAt: new Date("2026-06-02T00:00:00.000Z"),
  updatedAt: new Date("2026-06-02T00:00:00.000Z"),
} satisfies schema.SourceMapArtifact;

test("symbolicateStacktraceWithArtifact rewrites generated stack frames", () => {
  const result = symbolicateStacktraceWithArtifact({
    stacktrace: "TypeError: bad\n    at useMemoCache (index.android.bundle:1:1)",
    sourceMap,
    artifact,
  });

  assert.ok(result);
  assert.equal(result.stacktrace, "TypeError: bad\n    at HomeScreen (app/index.tsx:1:1)");
  assert.deepEqual(result.frames[0], {
    functionName: "HomeScreen",
    source: "app/index.tsx",
    line: 1,
    column: 1,
    generatedFile: "index.android.bundle",
    generatedLine: 1,
    generatedColumn: 1,
  });
});

test("symbolicationAttrsForSample extracts release, platform, dist, and debug id", () => {
  const sample = {
    kind: "log",
    service: "juno",
    severity: "ERROR",
    message: "bad",
    body: "bad",
    exceptionType: "TypeError",
    topFrame: null,
    normalizedFrames: [],
    stacktrace: "TypeError: bad\n    at index.android.bundle:1:1",
    seenAt: "2026-06-02T00:00:00.000Z",
    logAttrs: {
      "service.version": "juno@1.2.3",
      "device.platform": "Android",
      "expo.update_id": "update-1",
      "sourcemap.debug_id": "debug-1",
    },
    resourceAttrs: null,
  } satisfies IssueSample;

  assert.deepEqual(symbolicationAttrsForSample(sample), {
    debugId: "debug-1",
    release: "juno@1.2.3",
    dist: "update-1",
    platform: "android",
  });
});

test("symbolicateIssueSample loads matching source map object and symbolicates", async () => {
  const sample = {
    kind: "log",
    service: "juno",
    severity: "ERROR",
    message: "bad",
    body: "bad",
    exceptionType: "TypeError",
    topFrame: null,
    normalizedFrames: [],
    stacktrace: "TypeError: bad\n    at useMemoCache (index.android.bundle:1:1)",
    seenAt: "2026-06-02T00:00:00.000Z",
    logAttrs: {
      "service.version": "juno@1.2.3",
      "device.platform": "android",
    },
    resourceAttrs: null,
  } satisfies IssueSample;
  const database = {
    query: {
      sourceMapArtifacts: {
        findFirst: async () => null,
        findMany: async () => [artifact],
      },
    },
  } as unknown as DB;

  const result = await symbolicateIssueSample({
    database,
    objectReader: {
      async getSourceMapObject(input) {
        assert.equal(input.bucket, "source-map-bucket");
        assert.equal(input.key, "source-maps/project-1/android/hash.map.gz");
        return gzipSync(sourceMap);
      },
    },
    projectId: "project-1",
    sample,
  });

  assert.ok(result);
  assert.equal(result.artifact.id, "artifact-1");
  assert.equal(result.frames[0]?.source, "app/index.tsx");
});

test("findSourceMapArtifact prefers artifact matching generated stack frame file", async () => {
  const entryArtifact = {
    ...artifact,
    id: "entry-artifact",
    platform: "web",
    bundleFile: "dist/_expo/static/js/web/entry-abc123.js",
    mapFile: "dist/_expo/static/js/web/entry-abc123.js.map",
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  } satisfies schema.SourceMapArtifact;
  const indexArtifact = {
    ...artifact,
    id: "index-artifact",
    platform: "web",
    bundleFile: "dist/_expo/static/js/web/index-def456.js",
    mapFile: "dist/_expo/static/js/web/index-def456.js.map",
    createdAt: new Date("2026-06-02T00:01:00.000Z"),
    updatedAt: new Date("2026-06-02T00:01:00.000Z"),
  } satisfies schema.SourceMapArtifact;
  const database = {
    query: {
      sourceMapArtifacts: {
        findFirst: async () => null,
        findMany: async () => [indexArtifact, entryArtifact],
      },
    },
  } as unknown as DB;

  const result = await findSourceMapArtifact({
    database,
    projectId: "project-1",
    attrs: {
      debugId: null,
      release: "juno@1.2.3",
      dist: null,
      platform: "web",
    },
    stacktrace:
      "TypeError: bad\n    at useMemoCache (https://app.example.com/_expo/static/js/web/entry-abc123.js:1:1)",
  });

  assert.equal(result?.id, "entry-artifact");
});
