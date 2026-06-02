import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  type SourceMapObjectStore,
  prepareSourceMapUpload,
  sourceMapObjectKey,
  sourceMapUploadSchema,
} from "./sourcemaps.js";

const sourceMap = JSON.stringify({
  version: 3,
  debugId: "debug-123",
  sources: ["app/index.tsx"],
  mappings: "AAAA",
});

test("prepareSourceMapUpload verifies source map hash and compresses content", () => {
  const input = sourceMapUploadSchema.parse({
    platform: "ios",
    release: "app@1.0.0+1",
    debugId: "debug-123",
    mapFile: "dist/ios-main.hbc.map",
    sourceMap,
    sourceMapHash: createHash("sha256").update(sourceMap).digest("hex"),
    sourceMapBytes: Buffer.byteLength(sourceMap),
  });

  const prepared = prepareSourceMapUpload(input);

  assert.equal(prepared.sourceMapBytes, Buffer.byteLength(sourceMap));
  assert.equal(prepared.input.release, "app@1.0.0+1");
  assert.equal(gunzipSync(prepared.content).toString("utf8"), sourceMap);
});

test("prepareSourceMapUpload rejects mismatched hashes", () => {
  const input = sourceMapUploadSchema.parse({
    platform: "ios",
    release: "app@1.0.0+1",
    mapFile: "dist/ios-main.hbc.map",
    sourceMap,
    sourceMapHash: "0".repeat(64),
    sourceMapBytes: Buffer.byteLength(sourceMap),
  });

  assert.throws(() => prepareSourceMapUpload(input), /sourceMapHash/);
});

test("sourceMapObjectKey builds deterministic project-scoped S3 keys", () => {
  assert.equal(
    sourceMapObjectKey({
      prefix: "/source-maps/",
      projectId: "project-123",
      platform: "ios/simulator",
      sourceMapHash: "abcdef".padEnd(64, "0"),
    }),
    "source-maps/project-123/ios_simulator/ab/abcdef0000000000000000000000000000000000000000000000000000000000.map.gz",
  );
});

test("source map object stores receive compressed content outside Postgres", async () => {
  const input = sourceMapUploadSchema.parse({
    platform: "ios",
    release: "app@1.0.0+1",
    mapFile: "dist/ios-main.hbc.map",
    sourceMap,
    sourceMapHash: createHash("sha256").update(sourceMap).digest("hex"),
    sourceMapBytes: Buffer.byteLength(sourceMap),
  });
  const prepared = prepareSourceMapUpload(input);
  const stored: { bytes: Buffer; projectId: string }[] = [];
  const store: SourceMapObjectStore = {
    async putSourceMapObject(upload) {
      stored.push({ bytes: upload.artifact.content, projectId: upload.projectId });
      return { bucket: "source-map-bucket", key: "source-maps/project/hash.map.gz" };
    },
  };

  const object = await store.putSourceMapObject({ projectId: "project-123", artifact: prepared });

  assert.equal(object.bucket, "source-map-bucket");
  assert.equal(stored[0]?.projectId, "project-123");
  const storedObject = stored[0];
  assert.ok(storedObject);
  assert.equal(gunzipSync(storedObject.bytes).toString("utf8"), sourceMap);
});
