import type { Context, MiddlewareHandler } from "hono";
import type { AuthRateLimitRepository } from "./auth-global-rate-limit.js";

// Per-address limits for endpoints anyone can call that store something:
// an OAuth client registration, a pending device, or a sign-up intent.
// Counts live in the same table as the sign-in limits, so every API task
// shares them.
export type PublicEndpointLimit = { key: string; max: number; windowMs: number };

export const publicEndpointLimits = {
  oauthDevice: { key: "oauth-device", max: 30, windowMs: 10 * 60_000 },
  oauthRegister: { key: "oauth-register", max: 10, windowMs: 60 * 60_000 },
  signupIntents: { key: "signup-intents", max: 30, windowMs: 10 * 60_000 },
} satisfies Record<string, PublicEndpointLimit>;

export function publicEndpointRateLimit(
  repository: AuthRateLimitRepository,
  limit: PublicEndpointLimit,
  clientIp: (c: Context) => string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const decision = await repository.consume({
      key: `public:${limit.key}:${clientIp(c) ?? "no-client-ip"}`,
      max: limit.max,
      windowMs: limit.windowMs,
      nowEpochMs: Date.now(),
    });
    if (!decision.allowed) {
      const retryAfter = String(decision.retryAfterSeconds ?? Math.ceil(limit.windowMs / 1000));
      return c.json(
        { error: "too_many_requests", message: "Too many requests. Please try again later." },
        429,
        {
          "retry-after": retryAfter,
        },
      );
    }
    await next();
  };
}
