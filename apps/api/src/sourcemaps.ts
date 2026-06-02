import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DB } from "@superlog/db";
import * as schema from "@superlog/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const MAX_SOURCE_MAP_BYTES = 25 * 1024 * 1024;

export const sourceMapUploadSchema = z.object({
  platform: z.string().min(1).max(32),
  release: z.string().min(1).max(200),
  dist: z.string().min(1).max(200).optional(),
  debugId: z.string().min(1).max(200).optional(),
  bundleFile: z.string().min(1).max(500).optional(),
  mapFile: z.string().min(1).max(500),
  sourceMap: z.string().min(2),
  sourceMapHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceMapBytes: z.number().int().positive().max(MAX_SOURCE_MAP_BYTES),
});

export type SourceMapUploadInput = z.infer<typeof sourceMapUploadSchema>;

export type StoredSourceMapObject = {
  bucket: string;
  key: string;
};

export type SourceMapObjectStore = {
  putSourceMapObject(input: {
    projectId: string;
    artifact: PreparedSourceMapUpload;
  }): Promise<StoredSourceMapObject>;
};

export type SourceMapObjectReader = {
  getSourceMapObject(input: StoredSourceMapObject): Promise<Buffer>;
};

export class S3SourceMapObjectStore implements SourceMapObjectStore, SourceMapObjectReader {
  private readonly s3: S3Client;

  constructor(
    private readonly config: {
      bucket: string;
      prefix?: string;
      region?: string;
      endpoint?: string;
    },
  ) {
    if (!config.bucket) throw new Error("source map bucket is required");
    this.s3 = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint),
    });
  }

  async putSourceMapObject(input: {
    projectId: string;
    artifact: PreparedSourceMapUpload;
  }): Promise<StoredSourceMapObject> {
    const key = sourceMapObjectKey({
      prefix: this.config.prefix ?? "source-maps",
      projectId: input.projectId,
      platform: input.artifact.input.platform,
      sourceMapHash: input.artifact.sourceMapHash,
    });
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: input.artifact.content,
        ContentType: "application/json",
        ContentEncoding: "gzip",
        Metadata: {
          project_id: input.projectId,
          platform: input.artifact.input.platform,
          release: input.artifact.input.release,
          source_map_hash: input.artifact.sourceMapHash,
        },
      }),
    );
    return { bucket: this.config.bucket, key };
  }

  async getSourceMapObject(input: StoredSourceMapObject): Promise<Buffer> {
    const output = await this.s3.send(
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
    );
    if (!output.Body) throw new Error("source map object response is missing body");
    return Buffer.from(await output.Body.transformToByteArray());
  }
}

export function sourceMapObjectStoreFromEnv(
  env: NodeJS.ProcessEnv,
): (SourceMapObjectStore & SourceMapObjectReader) | null {
  const bucket = env.SOURCE_MAP_BUCKET;
  if (!bucket) return null;
  return new S3SourceMapObjectStore({
    bucket,
    prefix: env.SOURCE_MAP_PREFIX || "source-maps",
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    endpoint: env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT_URL || undefined,
  });
}

export type PreparedSourceMapUpload = {
  input: SourceMapUploadInput;
  content: Buffer;
  sourceMapHash: string;
  sourceMapBytes: number;
};

export function prepareSourceMapUpload(input: SourceMapUploadInput): {
  input: SourceMapUploadInput;
  content: Buffer;
  sourceMapHash: string;
  sourceMapBytes: number;
} {
  const sourceMapBytes = Buffer.byteLength(input.sourceMap);
  if (sourceMapBytes !== input.sourceMapBytes) {
    throw new Error("sourceMapBytes does not match sourceMap byte length");
  }
  const sourceMapHash = createHash("sha256").update(input.sourceMap).digest("hex");
  if (sourceMapHash !== input.sourceMapHash) {
    throw new Error("sourceMapHash does not match sourceMap content");
  }
  const parsed = JSON.parse(input.sourceMap) as { sources?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sources)) {
    throw new Error("sourceMap must be a JSON source map with a sources array");
  }
  return {
    input,
    content: gzipSync(input.sourceMap),
    sourceMapHash,
    sourceMapBytes,
  };
}

export async function storeSourceMapArtifact(opts: {
  database: DB;
  projectId: string;
  uploadedByOrgApiKeyId: string | null;
  objectStore: SourceMapObjectStore;
  input: SourceMapUploadInput;
}): Promise<schema.SourceMapArtifact> {
  const database = opts.database;
  const prepared = prepareSourceMapUpload(opts.input);
  const storedObject = await opts.objectStore.putSourceMapObject({
    projectId: opts.projectId,
    artifact: prepared,
  });
  const now = new Date();

  if (opts.input.debugId) {
    const existing = await database.query.sourceMapArtifacts.findFirst({
      where: and(
        eq(schema.sourceMapArtifacts.projectId, opts.projectId),
        eq(schema.sourceMapArtifacts.debugId, opts.input.debugId),
      ),
    });
    if (existing) {
      const [row] = await database
        .update(schema.sourceMapArtifacts)
        .set({
          platform: opts.input.platform,
          release: opts.input.release,
          dist: opts.input.dist ?? null,
          bundleFile: opts.input.bundleFile ?? null,
          mapFile: opts.input.mapFile,
          sourceMapHash: prepared.sourceMapHash,
          sourceMapBytes: prepared.sourceMapBytes,
          storageBucket: storedObject.bucket,
          storageKey: storedObject.key,
          contentEncoding: "gzip",
          uploadedByOrgApiKeyId: opts.uploadedByOrgApiKeyId,
          updatedAt: now,
        })
        .where(eq(schema.sourceMapArtifacts.id, existing.id))
        .returning();
      if (!row) throw new Error("failed to update source map artifact");
      return row;
    }
  }

  const [row] = await database
    .insert(schema.sourceMapArtifacts)
    .values({
      projectId: opts.projectId,
      platform: opts.input.platform,
      release: opts.input.release,
      dist: opts.input.dist ?? null,
      debugId: opts.input.debugId ?? null,
      bundleFile: opts.input.bundleFile ?? null,
      mapFile: opts.input.mapFile,
      sourceMapHash: prepared.sourceMapHash,
      sourceMapBytes: prepared.sourceMapBytes,
      storageBucket: storedObject.bucket,
      storageKey: storedObject.key,
      contentEncoding: "gzip",
      uploadedByOrgApiKeyId: opts.uploadedByOrgApiKeyId,
    })
    .returning();
  if (!row) throw new Error("failed to insert source map artifact");
  return row;
}

export function sourceMapObjectKey(input: {
  prefix: string;
  projectId: string;
  platform: string;
  sourceMapHash: string;
}): string {
  const prefix = trimSlashes(input.prefix) || "source-maps";
  return [
    prefix,
    input.projectId,
    sanitizePathSegment(input.platform),
    input.sourceMapHash.slice(0, 2),
    `${input.sourceMapHash}.map.gz`,
  ].join("/");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
