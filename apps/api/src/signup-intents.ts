import { API_KEY_PREFIX, LEGACY_API_KEY_PREFIX } from "@superlog/db/keys";

const KEY_PREFIX_SUFFIX_RE = /^[A-Za-z0-9_-]{6}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const RETURN_TO_MAX_LENGTH = 1024;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeSignupIntentKeyHash(value: unknown): string | null {
  return typeof value === "string" && SHA256_HEX_RE.test(value) ? value.toLowerCase() : null;
}

export function normalizeSignupIntentKeyPrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const tokenPrefix = [API_KEY_PREFIX, LEGACY_API_KEY_PREFIX].find((prefix) =>
    value.startsWith(prefix),
  );
  if (!tokenPrefix) return null;

  const suffix = value.slice(tokenPrefix.length);
  return KEY_PREFIX_SUFFIX_RE.test(suffix) ? value : null;
}

// returnTo sends the browser back to the local agent that started signup. Anyone
// can create an intent, so a remote target would make signup links open redirects.
export function normalizeSignupIntentReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > RETURN_TO_MAX_LENGTH) return null;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return LOOPBACK_HOSTNAMES.has(url.hostname) ? value : null;
}
