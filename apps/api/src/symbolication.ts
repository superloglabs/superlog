import { gunzipSync } from "node:zlib";
import { GREATEST_LOWER_BOUND, TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import type { DB, IssueSample } from "@superlog/db";
import * as schema from "@superlog/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { SourceMapObjectReader } from "./sourcemaps.js";

export type SymbolicatedFrame = {
  functionName: string | null;
  source: string;
  line: number;
  column: number;
  generatedFile: string;
  generatedLine: number;
  generatedColumn: number;
};

export type IssueSymbolication = {
  artifact: {
    id: string;
    release: string;
    dist: string | null;
    platform: string;
    debugId: string | null;
  };
  stacktrace: string;
  frames: SymbolicatedFrame[];
};

type StackFrameLine = {
  raw: string;
  prefix: string;
  functionName: string | null;
  file: string;
  line: number;
  column: number;
  suffix: string;
};

type SymbolicationAttrs = {
  debugId: string | null;
  release: string | null;
  dist: string | null;
  platform: string | null;
};

type RawSourceMap = {
  sources?: unknown;
  sourcesContent?: unknown;
};

type TelemetrySymbolicationSample = {
  stacktrace: string | null;
  logAttrs?: Record<string, string> | null;
  resourceAttrs?: Record<string, string> | null;
  spanAttrs?: Record<string, string> | null;
};

export async function symbolicateIssueSample(opts: {
  database: DB;
  objectReader: SourceMapObjectReader | null;
  projectId: string;
  sample: IssueSample | null | undefined;
}): Promise<IssueSymbolication | null> {
  return symbolicateTelemetrySample(opts);
}

export async function symbolicateTelemetrySample(opts: {
  database: DB;
  objectReader: SourceMapObjectReader | null;
  projectId: string;
  sample: TelemetrySymbolicationSample | null | undefined;
}): Promise<IssueSymbolication | null> {
  if (!opts.objectReader || !opts.sample?.stacktrace) return null;

  const attrs = symbolicationAttrsForSample(opts.sample);
  const artifact = await findSourceMapArtifact({
    database: opts.database,
    projectId: opts.projectId,
    attrs,
    stacktrace: opts.sample.stacktrace,
  });
  if (!artifact) return null;

  const gzippedMap = await opts.objectReader.getSourceMapObject({
    bucket: artifact.storageBucket,
    key: artifact.storageKey,
  });
  const mapJson = gunzipSync(gzippedMap).toString("utf8");
  return symbolicateStacktraceWithArtifact({
    stacktrace: opts.sample.stacktrace,
    sourceMap: mapJson,
    artifact,
  });
}

export async function findSourceMapArtifact(opts: {
  database: DB;
  projectId: string;
  attrs: SymbolicationAttrs;
  stacktrace?: string | null;
}): Promise<schema.SourceMapArtifact | null> {
  const stackFiles = stackFrameFiles(opts.stacktrace);
  if (opts.attrs.debugId) {
    const byDebugId = await opts.database.query.sourceMapArtifacts.findFirst({
      where: and(
        eq(schema.sourceMapArtifacts.projectId, opts.projectId),
        eq(schema.sourceMapArtifacts.debugId, opts.attrs.debugId),
      ),
    });
    if (byDebugId) return byDebugId;
  }

  if (!opts.attrs.release) return findProjectArtifactMatchingStackFile(opts, stackFiles);

  const rows = await opts.database.query.sourceMapArtifacts.findMany({
    where: and(
      eq(schema.sourceMapArtifacts.projectId, opts.projectId),
      eq(schema.sourceMapArtifacts.release, opts.attrs.release),
    ),
    orderBy: [desc(schema.sourceMapArtifacts.createdAt)],
    limit: 20,
  });

  const platform = opts.attrs.platform?.toLowerCase() ?? null;
  const dist = opts.attrs.dist ?? null;
  const candidates = rows.filter((row) => {
    if (platform && row.platform.toLowerCase() !== platform) return false;
    if (dist && row.dist !== dist) return false;
    return true;
  });
  const matchingCandidate = candidates.find((row) => artifactMatchesStackFile(row, stackFiles));
  if (matchingCandidate) return matchingCandidate;
  const projectStackMatch = await findProjectArtifactMatchingStackFile(opts, stackFiles);
  if (projectStackMatch) return projectStackMatch;
  return candidates[0] ?? null;
}

async function findProjectArtifactMatchingStackFile(
  opts: {
    database: DB;
    projectId: string;
  },
  stackFiles: string[],
): Promise<schema.SourceMapArtifact | null> {
  if (stackFiles.length === 0) return null;
  const rows = await opts.database.query.sourceMapArtifacts.findMany({
    where: eq(schema.sourceMapArtifacts.projectId, opts.projectId),
    orderBy: [desc(schema.sourceMapArtifacts.createdAt)],
    limit: 100,
  });
  return rows.find((row) => artifactMatchesStackFile(row, stackFiles)) ?? null;
}

export function symbolicateStacktraceWithArtifact(opts: {
  stacktrace: string;
  sourceMap: string;
  artifact: Pick<schema.SourceMapArtifact, "id" | "release" | "dist" | "platform" | "debugId">;
}): IssueSymbolication | null {
  const parsedSourceMap = JSON.parse(opts.sourceMap) as SourceMapInput & RawSourceMap;
  const traceMap = new TraceMap(parsedSourceMap);
  const frames: SymbolicatedFrame[] = [];
  const lines = opts.stacktrace.split("\n").map((line) => {
    const frame = parseStackFrameLine(line);
    if (!frame) return line;

    const original = originalPositionFor(traceMap, {
      line: frame.line,
      column: Math.max(0, frame.column - 1),
      bias: GREATEST_LOWER_BOUND,
    });
    if (!original.source || !original.line || original.column == null) return line;

    const functionName =
      original.name ??
      inferOriginalFunctionName(parsedSourceMap, original.source, original.line) ??
      frame.functionName;
    const symbolicated: SymbolicatedFrame = {
      functionName,
      source: original.source,
      line: original.line,
      column: original.column + 1,
      generatedFile: frame.file,
      generatedLine: frame.line,
      generatedColumn: frame.column,
    };
    frames.push(symbolicated);
    const displayName = symbolicated.functionName ?? frame.functionName;
    const location = `${symbolicated.source}:${symbolicated.line}:${symbolicated.column}`;
    if (displayName) return `${frame.prefix}${displayName} (${location})${frame.suffix}`;
    return `${frame.prefix}${location}${frame.suffix}`;
  });

  if (frames.length === 0) return null;
  return {
    artifact: {
      id: opts.artifact.id,
      release: opts.artifact.release,
      dist: opts.artifact.dist,
      platform: opts.artifact.platform,
      debugId: opts.artifact.debugId,
    },
    stacktrace: lines.join("\n"),
    frames,
  };
}

export function symbolicationAttrsForSample(
  sample: TelemetrySymbolicationSample,
): SymbolicationAttrs {
  const attrs = {
    ...sample.resourceAttrs,
    ...sample.logAttrs,
    ...((sample as IssueSample & { spanAttrs?: Record<string, string> | null }).spanAttrs ?? {}),
  };
  return {
    debugId: firstAttr(attrs, [
      "debug_id",
      "debugId",
      "superlog.debug_id",
      "sourcemap.debug_id",
      "sentry.debug_id",
      "hermes.debug_id",
    ]),
    release: firstAttr(attrs, ["service.version", "release", "app.version", "superlog.release"]),
    dist: firstAttr(attrs, [
      "dist",
      "release.dist",
      "superlog.dist",
      "expo.update_id",
      "expo.update_group_id",
    ]),
    platform: normalizePlatform(
      firstAttr(attrs, ["device.platform", "platform", "os.type", "expo.platform"]),
    ),
  };
}

function parseStackFrameLine(line: string): StackFrameLine | null {
  const withFunction = line.match(/^(\s*at\s+)(.*?)\s+\((.*):(\d+):(\d+)\)(.*)$/);
  if (withFunction) {
    return {
      raw: line,
      prefix: `${withFunction[1] ?? ""}`,
      functionName: withFunction[2] ?? null,
      file: withFunction[3] ?? "",
      line: Number(withFunction[4]),
      column: Number(withFunction[5]),
      suffix: withFunction[6] ?? "",
    };
  }

  const bare = line.match(/^(\s*at\s+)(.*):(\d+):(\d+)(.*)$/);
  if (!bare) return null;
  return {
    raw: line,
    prefix: `${bare[1] ?? ""}`,
    functionName: null,
    file: bare[2] ?? "",
    line: Number(bare[3]),
    column: Number(bare[4]),
    suffix: bare[5] ?? "",
  };
}

function firstAttr(attrs: Record<string, string | undefined>, keys: string[]): string | null {
  for (const key of keys) {
    const value = attrs[key];
    if (value) return value;
  }
  return null;
}

function normalizePlatform(value: string | null): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.includes("ios")) return "ios";
  if (lower.includes("android")) return "android";
  if (lower.includes("web")) return "web";
  return lower;
}

function stackFrameFiles(stacktrace: string | null | undefined): string[] {
  if (!stacktrace) return [];
  return stacktrace
    .split("\n")
    .map((line) => parseStackFrameLine(line)?.file)
    .filter((file): file is string => Boolean(file));
}

function artifactMatchesStackFile(
  artifact: schema.SourceMapArtifact,
  stackFiles: string[],
): boolean {
  const artifactPath = normalizeGeneratedFilePath(artifact.bundleFile);
  if (!artifactPath) return false;

  const artifactBasename = basename(artifactPath);
  return stackFiles.some((file) => {
    const stackPath = normalizeGeneratedFilePath(file);
    if (!stackPath) return false;
    if (stackPath === artifactPath || stackPath.endsWith(`/${artifactPath}`)) return true;
    return Boolean(artifactBasename && basename(stackPath) === artifactBasename);
  });
}

function normalizeGeneratedFilePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.split(/[?#]/, 1)[0]?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return trimSlashes(url.pathname);
  } catch {
    return trimSlashes(trimmed);
  }
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, "");
}

function basename(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

function inferOriginalFunctionName(
  sourceMap: RawSourceMap,
  source: string,
  line: number,
): string | null {
  if (!Array.isArray(sourceMap.sources) || !Array.isArray(sourceMap.sourcesContent)) return null;
  const sourceIndex = findSourceIndex(sourceMap.sources, source);
  if (sourceIndex < 0) return null;
  const content = sourceMap.sourcesContent[sourceIndex];
  if (typeof content !== "string") return null;

  const lines = content.split("\n");
  let braceDepth = 0;
  for (let index = Math.min(line - 1, lines.length - 1); index >= 0; index -= 1) {
    const sourceLine = lines[index] ?? "";
    const name = functionNameFromSourceLine(sourceLine);
    if (name && braceDepth === 0) return name;
    braceDepth += countChar(sourceLine, "}") - countChar(sourceLine, "{");
    if (braceDepth < 0) braceDepth = 0;
  }
  return null;
}

function countChar(value: string, char: "{" | "}"): number {
  let count = 0;
  for (const candidate of value) {
    if (candidate === char) count += 1;
  }
  return count;
}

function findSourceIndex(sources: unknown[], source: string): number {
  const exact = sources.findIndex((candidate) => candidate === source);
  if (exact >= 0) return exact;

  const normalizedSource = normalizeGeneratedFilePath(source);
  if (!normalizedSource) return -1;
  return sources.findIndex((candidate) => {
    if (typeof candidate !== "string") return false;
    return normalizeGeneratedFilePath(candidate) === normalizedSource;
  });
}

function functionNameFromSourceLine(line: string): string | null {
  const declaration = line.match(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (declaration?.[1]) return declaration[1];

  const assignedFunction = line.match(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/,
  );
  if (assignedFunction?.[1]) return assignedFunction[1];

  const arrow = line.match(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  );
  if (arrow?.[1]) return arrow[1];

  const propertyArrow = line.match(
    /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  );
  if (propertyArrow?.[1]) return propertyArrow[1];

  const method = line.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
  if (method?.[1] && !isControlKeyword(method[1])) return method[1];

  return null;
}

function isControlKeyword(value: string): boolean {
  return ["if", "for", "while", "switch", "catch", "function"].includes(value);
}
