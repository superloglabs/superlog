import type { SentryAuthorizationRepository } from "./authorization-session.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export function startSentryAuthorizationCleanup(input: {
  repository: Pick<SentryAuthorizationRepository, "expireReady">;
  intervalMs?: number;
  now?: () => Date;
  onError: (error: unknown) => void;
}): () => void {
  const expire = () => {
    void input.repository.expireReady(input.now?.() ?? new Date()).catch(input.onError);
  };
  expire();
  const interval = setInterval(expire, input.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
}
