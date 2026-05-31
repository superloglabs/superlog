import { API_KEY_PREFIX, LEGACY_API_KEY_PREFIX } from "@superlog/db/keys";

const KEY_PREFIX_SUFFIX_RE = /^[A-Za-z0-9_-]{6}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

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
