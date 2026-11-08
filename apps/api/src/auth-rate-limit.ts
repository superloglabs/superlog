import type { BetterAuthOptions } from "better-auth";

const FIFTEEN_MINUTES_SECONDS = 15 * 60;
const ONE_HOUR_SECONDS = 60 * 60;
export const AUTH_RATE_LIMIT_RETENTION_MS = ONE_HOUR_SECONDS * 1000;

export const AUTH_RATE_LIMIT = {
  enabled: true,
  // Use in-memory storage to avoid a race condition in better-auth v1.6's
  // database storage mode. That mode does a plain INSERT (no ON CONFLICT) for
  // new rate-limit keys; concurrent requests from the same IP both pass a
  // findMany check before either INSERT commits, causing a unique-constraint
  // violation on rate_limits_key_idx. better-auth catches the error and falls
  // back to incrementOne so the counter stays correct, but the failed INSERT
  // is recorded as an ERROR span and generates noisy incidents.
  //
  // Rate-limit state is therefore per-process rather than cross-instance. The
  // existing global pre-handler rate limit (60 req/min per IP, via the atomic
  // ON CONFLICT upsert in auth-rate-limit-repository.ts) remains cross-instance
  // and is the primary brute-force protection; these per-route in-memory limits
  // add per-instance defense-in-depth. When upgrading to better-auth v1.7+,
  // switch to customStorage.consume and wire the atomic repository here too.
  storage: "memory",
  // Better Auth uses the base window as its pruning horizon. Keep it at least
  // as long as the longest custom rule. A separate pre-handler guard applies
  // the aggregate per-IP limit across every auth route.
  window: ONE_HOUR_SECONDS,
  max: 60,
  customRules: {
    "/sign-in/email": { window: FIFTEEN_MINUTES_SECONDS, max: 5 },
    "/sign-up/email": { window: ONE_HOUR_SECONDS, max: 5 },
    "/forget-password": { window: ONE_HOUR_SECONDS, max: 3 },
    "/request-password-reset": { window: ONE_HOUR_SECONDS, max: 3 },
    "/send-verification-email": { window: ONE_HOUR_SECONDS, max: 3 },
    // Preserve Better Auth's stricter built-in limits for any present or
    // future credential endpoints before the catch-all rule is considered.
    "/sign-in/*": { window: 10, max: 3 },
    "/sign-up/*": { window: 10, max: 3 },
    "/change-password*": { window: 10, max: 3 },
    "/change-email*": { window: 10, max: 3 },
    "*": false,
  },
} satisfies NonNullable<BetterAuthOptions["rateLimit"]>;
