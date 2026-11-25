const GLOBAL_AUTH_WINDOW_MS = 60_000;
const GLOBAL_AUTH_MAX = 60;
const ACCOUNT_SIGN_IN_WINDOW_MS = 15 * 60_000;
const ACCOUNT_SIGN_IN_MAX = 10;

export type AuthRateLimitConsumeInput = {
  key: string;
  max: number;
  windowMs: number;
  nowEpochMs: number;
};

export type AuthRateLimitConsumeResult = {
  allowed: boolean;
  retryAfterSeconds: number | null;
};

export type AuthRateLimitRepository = {
  consume(input: AuthRateLimitConsumeInput): Promise<AuthRateLimitConsumeResult>;
};

export async function enforceGlobalAuthRateLimit(
  repository: AuthRateLimitRepository,
  clientIp: string | undefined,
  nowEpochMs = Date.now(),
): Promise<Response | null> {
  return enforceRateLimit(repository, {
    key: `auth:global:${clientIp ?? "no-client-ip"}`,
    max: GLOBAL_AUTH_MAX,
    windowMs: GLOBAL_AUTH_WINDOW_MS,
    nowEpochMs,
  });
}

// Better Auth's own sign-in rule is per client address, so guessing scales with
// the number of addresses an attacker controls. This bucket counts attempts
// against one account from every address. It is looser than the per-address
// rule so a stranger cannot lock a user out with a handful of requests.
export async function enforceAccountSignInRateLimit(
  repository: AuthRateLimitRepository,
  email: string | undefined,
  nowEpochMs = Date.now(),
): Promise<Response | null> {
  const account = email?.trim().toLowerCase();
  if (!account) return null;
  return enforceRateLimit(repository, {
    key: `auth:sign-in:account:${account}`,
    max: ACCOUNT_SIGN_IN_MAX,
    windowMs: ACCOUNT_SIGN_IN_WINDOW_MS,
    nowEpochMs,
  });
}

async function enforceRateLimit(
  repository: AuthRateLimitRepository,
  input: AuthRateLimitConsumeInput,
): Promise<Response | null> {
  const decision = await repository.consume(input);
  if (decision.allowed) return null;

  const retryAfter = String(decision.retryAfterSeconds ?? input.windowMs / 1000);
  return new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "content-type": "application/json",
      "retry-after": retryAfter,
      "x-retry-after": retryAfter,
    },
  });
}
