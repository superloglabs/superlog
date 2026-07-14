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
// error identity. Keep the match anchored and require the same request ID on
// START/END/REPORT so application output is never mistaken for the envelope.
const VERCEL_RUNTIME_REQUEST_ENVELOPE =
  /^\s*START RequestId:\s*(\S+)\s*\r?\n\[([A-Z]+)\]\s+\S+\s+status=(\d{3})\s*\r?\nEND RequestId:\s*\1\s*\r?\nREPORT RequestId:\s*\1(?:\s+[^\r\n]*)?\s*$/i;

function normalizeVercelRuntimeRequest(body: string): string | null {
  const match = body.match(VERCEL_RUNTIME_REQUEST_ENVELOPE);
  const method = match?.[2];
  const status = match?.[3];
  return method && status
    ? `vercel runtime request method=${method.toLowerCase()} status=${status}`
    : null;
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
    .replace(/^file:\/\//, "");

  out = out.replace(/^.*?\/((?:apps|packages|src|app|lib|pages)\/.*)$/, "$1");
  return out;
}
