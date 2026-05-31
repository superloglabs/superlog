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

  return {
    hash,
    exceptionType: type,
    topFrame: normalized[0] ?? null,
    normalizedFrames: normalized,
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
    exceptionType: type,
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

function unwrapAnthropicErrorMessage(raw: string): string {
  // SDK errors land as `<status> <json>`; pull `error.message` if present so we
  // hash the human-readable failure, not the JSON wrapper.
  const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m && m[1] ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : raw;
}

export function normalizeMessage(body: string): string {
  let s = body;
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
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
      continue;
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
