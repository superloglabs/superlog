import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { DB, IssueSample } from "@superlog/db";
import type * as schema from "@superlog/db/schema";
import {
  findSourceMapArtifact,
  symbolicateIssueSample,
  symbolicateStacktraceWithArtifact,
  symbolicateTelemetrySample,
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

test("symbolicateTelemetrySample symbolicates logs without issue rows", async () => {
  const database = {
    query: {
      sourceMapArtifacts: {
        findFirst: async () => null,
        findMany: async () => [artifact],
      },
    },
  } as unknown as DB;

  const result = await symbolicateTelemetrySample({
    database,
    objectReader: {
      async getSourceMapObject(input) {
        assert.equal(input.bucket, "source-map-bucket");
        assert.equal(input.key, "source-maps/project-1/android/hash.map.gz");
        return gzipSync(sourceMap);
      },
    },
    projectId: "project-1",
    sample: {
      stacktrace: "TypeError: bad\n    at useMemoCache (index.android.bundle:1:1)",
      logAttrs: {
        "service.version": "juno@1.2.3",
        "device.platform": "android",
      },
      resourceAttrs: null,
    },
  });

  assert.ok(result);
  assert.equal(result.artifact.id, "artifact-1");
  assert.equal(result.frames[0]?.source, "app/index.tsx");
});

test("symbolicateTelemetrySample returns null when a log has no stacktrace", async () => {
  const result = await symbolicateTelemetrySample({
    database: {} as DB,
    objectReader: null,
    projectId: "project-1",
    sample: {
      stacktrace: null,
      logAttrs: null,
      resourceAttrs: null,
    },
  });

  assert.equal(result, null);
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

test("findSourceMapArtifact falls back to generated stack frame file when release is missing", async () => {
  const entryArtifact = {
    ...artifact,
    id: "entry-artifact",
    platform: "web",
    release: "expo-test-2@local",
    bundleFile: "dist-superlog/_expo/static/js/web/entry-90d9514ed4f128f73d2feaf2e08ff315.js",
    mapFile: "dist-superlog/_expo/static/js/web/entry-90d9514ed4f128f73d2feaf2e08ff315.js.map",
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  } satisfies schema.SourceMapArtifact;
  const database = {
    query: {
      sourceMapArtifacts: {
        findFirst: async () => null,
        findMany: async () => [entryArtifact],
      },
    },
  } as unknown as DB;

  const result = await findSourceMapArtifact({
    database,
    projectId: "project-1",
    attrs: {
      debugId: null,
      release: null,
      dist: null,
      platform: null,
    },
    stacktrace:
      "Error: Expo SDK demo error\n    at L (http://localhost:8093/_expo/static/js/web/entry-90d9514ed4f128f73d2feaf2e08ff315.js:1095:1077)",
  });

  assert.equal(result?.id, "entry-artifact");
});

test("findSourceMapArtifact falls back to generated stack frame file when release attrs do not match upload release", async () => {
  const entryArtifact = {
    ...artifact,
    id: "entry-artifact",
    platform: "web",
    release: "expo-test-2@local",
    dist: null,
    bundleFile: "dist-superlog/_expo/static/js/web/entry-90d9514ed4f128f73d2feaf2e08ff315.js",
    mapFile: "dist-superlog/_expo/static/js/web/entry-90d9514ed4f128f73d2feaf2e08ff315.js.map",
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  } satisfies schema.SourceMapArtifact;
  const database = {
    query: {
      sourceMapArtifacts: {
        findFirst: async () => null,
        findMany: async (_query: unknown) => [entryArtifact],
      },
    },
  } as unknown as DB;

  const result = await findSourceMapArtifact({
    database,
    projectId: "project-1",
    attrs: {
      debugId: null,
      release: "1.0.0",
      dist: "embedded",
      platform: "web",
    },
    stacktrace:
      "Error: Expo SDK demo error\n    at L (http://localhost:8093/_expo/static/js/web/entry-90d9514ed4f128f73d2feaf2e08ff315.js:1095:1077)",
  });

  assert.equal(result?.id, "entry-artifact");
});
