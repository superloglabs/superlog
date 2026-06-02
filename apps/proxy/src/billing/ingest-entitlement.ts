// Ingest entitlement gate for the free-tier telemetry hard-block. The proxy is
// the latency-critical, shared-event-loop ingest edge (it has been OOM'd under
// burst before), so Autumn MUST stay off the synchronous path: `allows()` is a
// pure in-memory cache read that returns instantly, fails OPEN on anything it
// doesn't know, and only schedules a background refresh. The next requests see
// the refreshed verdict. A few seconds of boundary overage is fine; a blocking
// network call or a billing outage taking ingest down is not.
//
// Only an explicit Autumn `allowed: false` (free org past its monthly cap)
// blocks; unknown orgs, missing config, and refresh errors all allow.
import { logger } from "../logger.js";

export type IngestSignal = "spans" | "logs" | "metric_points";

export function signalForPath(path: string): IngestSignal | null {
  if (path === "/v1/traces") return "spans";
  if (path === "/v1/logs") return "logs";
  if (path === "/v1/metrics") return "metric_points";
  return null;
}

export type IngestEntitlementGate = {
  // Sync, hot-path. Cached verdict; defaults to allow on miss/unknown/error.
  allows(projectId: string, signal: IngestSignal): boolean;
};

type Entry = { allowed: boolean; expiresAt: number };

const DEFAULT_TTL_MS = 60_000;
const ERROR_TTL_MS = 15_000; // retry sooner after an error, but don't hammer

export function createEntitlementCache(deps: {
  // Resolve the Autumn customer (org) for a project. null → allow.
  lookupOrgId: (projectId: string) => Promise<string | null>;
  // Ask Autumn whether the org may still ingest this signal.
  check: (orgId: string, featureId: IngestSignal) => Promise<boolean>;
  ttlMs?: number;
  now?: () => number;
}): IngestEntitlementGate {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Set<string>();

  // Bound memory in the long-lived proxy: evict the oldest entry once a NEW key
  // would push past the cap (Map preserves insertion order). 50k keys (~16k
  // projects × 3 signals) is far above any realistic active set within one TTL.
  const MAX_ENTRIES = 50_000;
  function setEntry(key: string, entry: Entry): void {
    if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
  }

  function refresh(key: string, projectId: string, signal: IngestSignal): void {
    if (inflight.has(key)) return;
    inflight.add(key);
    void (async () => {
      try {
        const orgId = await deps.lookupOrgId(projectId);
        const allowed = orgId ? await deps.check(orgId, signal) : true;
        setEntry(key, { allowed, expiresAt: now() + ttlMs });
      } catch (err) {
        // Fail open: never let a billing/lookup error block customer telemetry.
        setEntry(key, { allowed: true, expiresAt: now() + ERROR_TTL_MS });
        logger.warn(
          { scope: "billing.ingest_gate", projectId, signal, err: err instanceof Error ? err.message : String(err) },
          "entitlement refresh failed; allowing ingest (fail-open)",
        );
      } finally {
        inflight.delete(key);
      }
    })();
  }

  return {
    allows(projectId, signal) {
      const key = `${projectId}:${signal}`;
      const entry = cache.get(key);
      if (!entry || entry.expiresAt <= now()) {
        refresh(key, projectId, signal); // async; never awaited on the hot path
      }
      // Use the last-known verdict (so a blocked org stays blocked across the
      // refresh), defaulting to allow when we've never resolved it.
      return entry ? entry.allowed : true;
    },
  };
}

// Autumn /check for a feature. Returns true unless Autumn explicitly says false.
function createAutumnCheck(secretKey: string, fetchImpl: typeof fetch = fetch) {
  return async (orgId: string, featureId: IngestSignal): Promise<boolean> => {
    const res = await fetchImpl("https://api.useautumn.com/v1/check", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: orgId, feature_id: featureId }),
    });
    if (!res.ok) throw new Error(`autumn /check -> ${res.status}`);
    const body = (await res.json()) as { allowed?: boolean };
    return body.allowed !== false;
  };
}

// Returns null when AUTUMN_SECRET_KEY is unset — no billing, no blocking
// (dev/worktrees/self-hosted ingest unaffected). Also returns null unless
// BILLING_ENFORCEMENT_ENABLED is "true": the hard-block is gated SEPARATELY from
// metering, so we can turn billing on (the worker feeder still meters usage and
// bills paying customers) without 402-capping anyone's ingest. Flip the env to
// "true" when ready to actually enforce the Free caps.
export function createIngestEntitlementGate(opts: {
  lookupOrgForProject: (projectId: string) => Promise<{ orgId: string } | null>;
  secretKey?: string | null;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}): IngestEntitlementGate | null {
  const secretKey = (opts.secretKey ?? process.env.AUTUMN_SECRET_KEY)?.trim();
  if (!secretKey) return null;
  if (process.env.BILLING_ENFORCEMENT_ENABLED !== "true") return null;
  return createEntitlementCache({
    lookupOrgId: async (projectId) => (await opts.lookupOrgForProject(projectId))?.orgId ?? null,
    check: createAutumnCheck(secretKey, opts.fetchImpl),
    ttlMs: opts.ttlMs,
  });
}
