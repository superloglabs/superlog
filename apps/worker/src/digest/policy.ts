export type DigestPolicy = {
  intervalMs: number;
  retryCooldownMs: number;
  candidateLookbackMs: number;
  candidateLimit: number;
};

export const DEFAULT_DIGEST_POLICY: DigestPolicy = {
  intervalMs: 7 * 24 * 60 * 60 * 1000,
  retryCooldownMs: 5 * 60 * 1000,
  candidateLookbackMs: 14 * 24 * 60 * 60 * 1000,
  candidateLimit: 25,
};

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function digestPolicyFromEnv(): DigestPolicy {
  return {
    intervalMs: numberFromEnv("DIGEST_INTERVAL_MS", DEFAULT_DIGEST_POLICY.intervalMs),
    retryCooldownMs: numberFromEnv(
      "DIGEST_RETRY_COOLDOWN_MS",
      DEFAULT_DIGEST_POLICY.retryCooldownMs,
    ),
    candidateLookbackMs: numberFromEnv(
      "DIGEST_CANDIDATE_LOOKBACK_MS",
      DEFAULT_DIGEST_POLICY.candidateLookbackMs,
    ),
    candidateLimit: numberFromEnv("DIGEST_CANDIDATE_LIMIT", DEFAULT_DIGEST_POLICY.candidateLimit),
  };
}
