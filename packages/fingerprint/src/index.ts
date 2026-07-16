import { createHash } from "node:crypto";

export type Fingerprint = {
  hash: string;
  exceptionType: string;
  topFrame: string | null;
  normalizedFrames: string[];
};

export type LogFingerprintInput = {
  service: string;
  severity: string;
  body: string;
  exceptionType?: string | null;
  stacktrace?: string | null;
};

type Frame = { fn: string | null; path: string };

const TOP_N_FRAMES = 5;
const HASH_LEN = 16;

const IGNORE_PATH = [
  /node_modules\//,
  /^node:internal\//,
  /^node:async_hooks/,
  /async_hooks\.js/,
  /^webpack:\/\/\//,
];

const NUL_BYTE = String.fromCharCode(0);

// Postgres `text` and `jsonb` columns reject the NUL byte (0x00) with
// `22021 invalid byte sequence for encoding "UTF8": 0x00`. Telemetry can carry
// a raw NUL inside an exception message, body, or stack frame, and these
// fingerprint outputs flow straight into the issues upsert — so strip NUL
// before it can poison a parameter. Passes null/undefined through unchanged.
export function stripNullBytes<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? value.split(NUL_BYTE).join("") : value) as T;
}

export function fingerprint(input: {
  type: string;
  stacktrace: string | null | undefined;
  message?: string | null;
}): Fingerprint {
  const type = input.type || "Error";
  const frames = parseFrames(input.stacktrace ?? "");
  const userFrames = frames.filter(isUserFrame).slice(0, TOP_N_FRAMES);

  const picked = userFrames.length > 0 ? userFrames : frames.slice(0, TOP_N_FRAMES);
  const normalized = picked.map(formatFrame);
  const messageBucket = messageBucketFor(input.message);
  const canonical = `${type}::${messageBucket}::${normalized.join("|")}`;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, HASH_LEN);

  // The hash is hex (always safe); the human-readable fields below are persisted
  // to Postgres, so they must be NUL-free.
  const safeFrames = normalized.map((frame) => stripNullBytes(frame));
  return {
    hash,
    exceptionType: stripNullBytes(type),
    topFrame: safeFrames[0] ?? null,
    normalizedFrames: safeFrames,
  };
}

export function fingerprintLog(input: LogFingerprintInput): Fingerprint {
  if (input.stacktrace && input.stacktrace.trim().length > 0) {
    return fingerprint({
      type: input.exceptionType || input.severity || "LogError",
      stacktrace: input.stacktrace,
    });
  }

  const type = input.exceptionType || input.severity || "LogError";
  const service = input.service || "unknown";
  const normalized = normalizeMessage(input.body ?? "");
  const canonical = `log::${service}::${type}::${normalized}`;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, HASH_LEN);

  return {
    hash,
    exceptionType: stripNullBytes(type),
    topFrame: null,
    normalizedFrames: [],
  };
}

// Bucket key for grouping by error message. Lighter than `normalizeMessage`:
// preserves alphabetic content (so `model is not supported` doesn't collapse
// onto `extra inputs are not permitted`) but strips identifiers that vary per
// occurrence. Anthropic-style envelopes are unwrapped first so the per-request
// `request_id` doesn't leak into the bucket.
const MESSAGE_BUCKET_MAX = 160;
export function messageBucketFor(message: string | null | undefined): string {
  if (!message) return "";
  let s = unwrapAnthropicErrorMessage(message);
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
  s = collapseRequestPaths(s);
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  s = s.replace(/\b[A-Za-z0-9_]{20,}\b/g, "<id>");
  s = s.replace(/\b\d+\b/g, "<n>");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.length > MESSAGE_BUCKET_MAX ? s.slice(0, MESSAGE_BUCKET_MAX) : s;
}

// Collapse leading-slash request paths to a single `<path>` token. A route
// scanner hammering a server emits one error per probed URL (`/wp-admin`,
// `/.env`, `/.git/config`, …) that are otherwise identical — same type, same
// stacktrace. Without this every probed path becomes its own fingerprint, so a
// single bot sweep explodes into tens of thousands of distinct issues and
// floods ingestion. We only collapse a slash at a token boundary (start or
// after whitespace) so in-word slashes like `and/or` or `client/server` stay
// intact. The HTTP method (`GET`/`POST`) is left alone, so a sweep groups into
// at most a handful of issues (one per method) instead of thousands.
function collapseRequestPaths(s: string): string {
  return s.replace(/(^|\s)\/\S*/g, "$1<path>");
}

function unwrapAnthropicErrorMessage(raw: string): string {
  // SDK errors land as `<status> <json>`; pull `error.message` if present so we
  // hash the human-readable failure, not the JSON wrapper.
  const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m?.[1] ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : raw;
}

export function normalizeMessage(body: string): string {
  const vercelRuntimeRequest = normalizeVercelRuntimeRequest(body);
  if (vercelRuntimeRequest) return vercelRuntimeRequest;

  let s = body;
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
  s = collapseRequestPaths(s);
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, "<str>");
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "<str>");
  s = s.replace(/\b[0-9a-f]{20,}\b/gi, "<hex>");
  s = s.replace(/\b\d+\b/g, "<n>");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

// Vercel log drains can emit one four-line runtime envelope per request. Its
// request ID, path, timings, and memory figures are occurrence metadata, not
// error identity. Recognize exactly four lines and require the same request ID
// on START/END/REPORT so application output is never mistaken for the envelope.
const START_REQUEST_ID = "START RequestId:";
const END_REQUEST_ID = "END RequestId:";
const REPORT_REQUEST_ID = "REPORT RequestId:";
const VERSION_METADATA = "Version:";

function normalizeVercelRuntimeRequest(body: string): string | null {
  const lines = body
    .trim()
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length !== 4) return null;

  const [startLine, requestLine, endLine, reportLine] = lines;
  if (!startLine || !requestLine || !endLine || !reportLine) return null;

  const requestId = startRequestId(startLine);
  if (!requestId || requestIdFromLine(endLine, END_REQUEST_ID) !== requestId) return null;
  if (reportRequestId(reportLine) !== requestId) return null;

  const request = parseVercelRequestLine(requestLine);
  return request
    ? `vercel runtime request method=${request.method.toLowerCase()} status=${request.status}`
    : null;
}

function startRequestId(line: string): string | null {
  if (!line.startsWith(START_REQUEST_ID)) return null;
  const rest = line.slice(START_REQUEST_ID.length).trim();
  if (!rest) return null;

  const boundary = firstWhitespaceIndex(rest);
  if (boundary === -1) return rest;

  const requestId = rest.slice(0, boundary);
  const metadata = rest.slice(boundary).trimStart();
  if (!metadata.startsWith(VERSION_METADATA)) return null;
  const version = metadata.slice(VERSION_METADATA.length).trim();
  return version && !hasWhitespace(version) ? requestId : null;
}

function requestIdFromLine(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  const requestId = line.slice(prefix.length).trim();
  return requestId && !hasWhitespace(requestId) ? requestId : null;
}

function reportRequestId(line: string): string | null {
  if (!line.startsWith(REPORT_REQUEST_ID)) return null;
  const rest = line.slice(REPORT_REQUEST_ID.length).trimStart();
  if (!rest) return null;
  const boundary = firstWhitespaceIndex(rest);
  return boundary === -1 ? rest : rest.slice(0, boundary);
}

function parseVercelRequestLine(line: string): { method: string; status: string } | null {
  if (!line.startsWith("[")) return null;
  const methodEnd = line.indexOf("]");
  if (methodEnd <= 1) return null;

  const method = line.slice(1, methodEnd);
  if (!isAsciiLetters(method) || !isWhitespace(line[methodEnd + 1])) return null;

  let pathStart = methodEnd + 1;
  while (isWhitespace(line[pathStart])) pathStart += 1;

  const statusStart = line.lastIndexOf("status=");
  if (statusStart <= pathStart || !isWhitespace(line[statusStart - 1])) return null;

  let pathEnd = statusStart;
  while (pathEnd > pathStart && isWhitespace(line[pathEnd - 1])) pathEnd -= 1;
  const path = line.slice(pathStart, pathEnd);
  const status = line.slice(statusStart + "status=".length).trim();
  if (!path || hasWhitespace(path) || !isThreeDigits(status)) return null;

  return { method, status };
}

function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (isWhitespace(value[index])) return index;
  }
  return -1;
}

function hasWhitespace(value: string): boolean {
  return firstWhitespaceIndex(value) !== -1;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "";
}

function isAsciiLetters(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    if (!isUppercase && !isLowercase) return false;
  }
  return true;
}

function isThreeDigits(value: string): boolean {
  if (value.length !== 3) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function parseFrames(stacktrace: string): Frame[] {
  const out: Frame[] = [];
  for (const raw of stacktrace.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3);

    const withFn = body.match(/^(.+?)\s+\((.+?):\d+:\d+\)$/);
    if (withFn) {
      out.push({ fn: withFn[1] ?? null, path: withFn[2] ?? "" });
      continue;
    }

    const bare = body.match(/^(.+?):\d+:\d+$/);
    if (bare) {
      out.push({ fn: null, path: bare[1] ?? "" });
    }
  }
  return out;
}

function isUserFrame(f: Frame): boolean {
  return !IGNORE_PATH.some((re) => re.test(f.path));
}

function formatFrame(f: Frame): string {
  const path = normalizePath(f.path);
  return f.fn ? `${f.fn}@${path}` : path;
}

function normalizePath(p: string): string {
  let out = p
    .replace(/^webpack-internal:\/\/\/?/, "")
    .replace(/^\([^)]*\)\//, "")
    .replace(/^\.\//, "")
    .replace(/^file:\/\//, "")
    // iOS assigns each installed app a different UUID-named sandbox. Hermes
    // includes that absolute sandbox path in frames, but it is deployment
    // metadata rather than part of the failing code's identity.
    .replace(
      /\/var\/mobile\/Containers\/Data\/Application\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i,
      "/var/mobile/Containers/Data/Application/<uuid>/",
    )
    // Expo gives the generated Hermes bundle a build-specific name. The
    // function names still identify the failing code across app releases.
    .replace(/(\/\.expo-internal\/)[^/]+\.(?:js)?bundle$/i, "$1<bundle>");

  out = out.replace(/^.*?\/((?:apps|packages|src|app|lib|pages)\/.*)$/, "$1");
  return out;
}
