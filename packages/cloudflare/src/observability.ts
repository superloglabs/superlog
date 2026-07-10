// Cloudflare Workers Observability wiring — shared by the api (connect flow +
// per-Worker wire/unwire routes) and the worker (periodic reconcile job).
//
// Creating an account-level telemetry destination is not enough: a Worker only
// exports to a destination when its OWN `observability` config enables the
// signal and lists the destination by name. So wiring reads each Worker's
// settings and merges our destination slugs in. That per-Worker link is set once
// at connect, so a Worker created/recreated/renamed later comes up unwired —
// which is what the reconcile job re-applies on a schedule.
//
// This lived in apps/api/src/cloudflare-service.ts until the worker needed it
// too; it's here (mirroring @superlog/railway owning its client) so both share
// exactly one implementation and "wired" can never drift from "wire". The api
// re-exports these so its existing imports are unchanged.
//
// IO-light: pure merge functions + thin wrappers over an injectable `fetch`.

import type { FetchImpl } from "./oauth.js";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Our destination slugs for a Worker, per signal (metrics isn't a Worker signal). */
export type WorkerDestinationSlugs = { traces?: string; logs?: string };

export type WorkerObservabilitySignal = {
  enabled?: boolean;
  destinations?: string[];
  [k: string]: unknown;
};
export type WorkerObservability = {
  enabled?: boolean;
  logs?: WorkerObservabilitySignal;
  traces?: WorkerObservabilitySignal;
  [k: string]: unknown;
};

/** signal → the Worker `observability` sub-key it maps to (metrics isn't a Worker signal). */
const WORKER_OBSERVABILITY_SIGNALS = ["logs", "traces"] as const;

/**
 * Pull a human-readable error out of a failed Cloudflare API response. Cloudflare
 * uses two shapes: the standard envelope `{errors:[{message}]}`, and — for
 * request-body validation — a Zod error `{error:{name, issues:[{message,path}]}}`
 * (mirrored as `_error`). Surfacing both keeps a validation failure from being
 * flattened to a generic "request_failed".
 */
export function extractCloudflareApiError(o: Record<string, unknown>): string {
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const first = errors[0] as Record<string, unknown> | undefined;
  if (first && typeof first.message === "string") return first.message;

  const zod = (o.error ?? o._error) as Record<string, unknown> | undefined;
  if (zod && typeof zod === "object") {
    const issues = Array.isArray(zod.issues) ? zod.issues : [];
    const msgs = issues
      .map((i) => (i as Record<string, unknown>)?.message)
      .filter((m): m is string => typeof m === "string");
    if (msgs.length > 0) return msgs.join("; ");
    if (typeof zod.name === "string") return zod.name;
  }
  return "request_failed";
}

/**
 * Merge our destination slugs into a Worker's existing observability config so it
 * exports the matching signals to our intake. Additive and idempotent: turns on
 * observability and each wired signal, and appends our slug to that signal's
 * `destinations` without dropping the Worker's existing destinations, sampling
 * rates, or any other fields. Returns the updated config, or `null` when the
 * Worker is already wired (nothing to change) so the caller can skip the PATCH.
 */
export function wireObservabilityDestinations(
  current: WorkerObservability | null | undefined,
  slugs: WorkerDestinationSlugs,
): WorkerObservability | null {
  const next: WorkerObservability = current ? { ...current } : {};
  let changed = false;
  if (next.enabled !== true) {
    next.enabled = true;
    changed = true;
  }
  for (const signal of WORKER_OBSERVABILITY_SIGNALS) {
    const slug = slugs[signal];
    if (!slug) continue;
    const sig: WorkerObservabilitySignal = { ...(next[signal] ?? {}) };
    const destinations = Array.isArray(sig.destinations) ? [...sig.destinations] : [];
    if (sig.enabled !== true) {
      sig.enabled = true;
      changed = true;
    }
    if (!destinations.includes(slug)) {
      destinations.push(slug);
      changed = true;
    }
    sig.destinations = destinations;
    next[signal] = sig;
  }
  return changed ? next : null;
}

/**
 * Remove our destination slugs from a Worker's observability config (the inverse
 * of wireObservabilityDestinations). Only strips our slug from each signal's
 * `destinations` — it leaves the signal enabled and any other destinations the
 * Worker uses untouched, so unwiring from us never disables the Worker's own
 * observability. Returns the updated config, or `null` when none of our slugs
 * were present (nothing to change) so the caller can skip the PATCH.
 */
export function unwireObservabilityDestinations(
  current: WorkerObservability | null | undefined,
  slugs: WorkerDestinationSlugs,
): WorkerObservability | null {
  if (!current) return null;
  const next: WorkerObservability = { ...current };
  let changed = false;
  for (const signal of WORKER_OBSERVABILITY_SIGNALS) {
    const slug = slugs[signal];
    if (!slug) continue;
    const existing = next[signal];
    if (!existing || !Array.isArray(existing.destinations)) continue;
    if (!existing.destinations.includes(slug)) continue;
    next[signal] = { ...existing, destinations: existing.destinations.filter((d) => d !== slug) };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Whether a Worker is fully wired to our destinations — i.e. wiring would be a
 * no-op. Defined in terms of wireObservabilityDestinations so "wired" and "wire"
 * can never drift: if wiring returns null there's nothing to add, so it's wired.
 */
export function isWorkerWired(
  current: WorkerObservability | null | undefined,
  slugs: WorkerDestinationSlugs,
): boolean {
  return wireObservabilityDestinations(current, slugs) === null;
}

// ---------------------------------------------------------------------------
// HTTP wrappers (injectable fetch)
// ---------------------------------------------------------------------------

/** Parse `GET /workers/scripts` → list of script (Worker) ids. */
export function parseScriptsResponse(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const result = (json as Record<string, unknown>).result;
  if (!Array.isArray(result)) return [];
  const ids: string[] = [];
  for (const item of result) {
    const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : null;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/** List the Worker script ids in an account. Returns [] on any failure. */
export async function listScripts(
  accountId: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => null);
  return parseScriptsResponse(json);
}

/**
 * Strict variant of listScripts for interactive management routes: THROWS on a
 * failed read (non-OK HTTP or `success !== true`) instead of collapsing it to an
 * empty list. The tolerant listScripts hides an account-level failure as "no
 * Workers" — fine for a best-effort background pass, wrong for a user staring at
 * the settings card, who should see a reconnect/upstream error instead of an
 * account that looks empty. Mirrors getScriptObservability's throw-on-failure.
 */
export async function listScriptsStrict(
  accountId: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.success !== true) {
    throw new Error(`cloudflare: list worker scripts failed (status ${res.status})`);
  }
  return parseScriptsResponse(json);
}

/**
 * Read one Worker's `observability` config. Returns `null` only on a *successful*
 * read where observability is unset (a genuinely fresh Worker). A failed read
 * (non-OK HTTP or `success !== true`) THROWS — the caller must not treat that as
 * "fresh" and PATCH a minimal config, which would clobber an existing
 * observability block we simply couldn't read.
 */
export async function getScriptObservability(input: {
  accountId: string;
  script: string;
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<WorkerObservability | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(
      input.script,
    )}/settings`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.success !== true) {
    throw new Error(`cloudflare: read worker settings failed (status ${res.status})`);
  }
  const result = json.result as Record<string, unknown> | undefined;
  const obs = result?.observability;
  return obs && typeof obs === "object" ? (obs as WorkerObservability) : null;
}

/**
 * PATCH a Worker's settings to set its `observability` config. The settings
 * endpoint only accepts `multipart/form-data` with a JSON `settings` part (not a
 * JSON body), so we build a FormData and let fetch set the multipart boundary.
 */
export async function updateScriptObservability(input: {
  accountId: string;
  script: string;
  observability: WorkerObservability;
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: boolean; error?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.append(
    "settings",
    new Blob([JSON.stringify({ observability: input.observability })], {
      type: "application/json",
    }),
    "settings.json",
  );
  try {
    const res = await fetchImpl(
      `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(
        input.script,
      )}/settings`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${input.accessToken}` },
        body: form,
      },
    );
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (json?.success === true) return { ok: true };
    return { ok: false, error: extractCloudflareApiError(json ?? {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request_failed" };
  }
}

// ---------------------------------------------------------------------------
// Reconcile — the idempotent "wire every Worker in the account" pass, shared by
// connect / wire-all (api) and the periodic reconcile (worker).
// ---------------------------------------------------------------------------

export type WiringLogger = {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
};

/**
 * Wire every Worker in an account to our destinations. Reads each Worker's
 * observability and merges our slugs in (additive + idempotent), PATCHing only
 * the ones that actually drifted. Best-effort and per-Worker isolated: a Worker
 * we can't read/update is logged and skipped, never failing the pass — so this
 * never throws for a wiring failure. Only traces/logs are wired (Workers
 * Observability has no per-Worker metrics signal).
 *
 * `listOk` reports whether the account-level scripts list actually succeeded:
 * the background reconcile can ignore a transient list failure (retry next
 * hour), but the interactive "Wire all" route uses it to surface a reconnect /
 * upstream error instead of silently reporting "0 workers".
 */
export async function reconcileWorkerWiring(input: {
  accountId: string;
  accessToken: string;
  slugs: WorkerDestinationSlugs;
  fetchImpl?: FetchImpl;
  log?: WiringLogger;
}): Promise<{ scripts: number; wired: number; listOk: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const slugs = { traces: input.slugs.traces, logs: input.slugs.logs };
  if (!slugs.traces && !slugs.logs) return { scripts: 0, wired: 0, listOk: true };
  let scripts: string[];
  try {
    scripts = await listScriptsStrict(input.accountId, input.accessToken, fetchImpl);
  } catch (e) {
    // Account-level list failure: don't throw (a background pass just retries),
    // but report listOk:false so an interactive caller can surface the error.
    input.log?.warn(
      { err: e instanceof Error ? e.message : String(e), account_id: input.accountId },
      "cloudflare: list worker scripts failed",
    );
    return { scripts: 0, wired: 0, listOk: false };
  }
  let wired = 0;
  for (const script of scripts) {
    try {
      const current = await getScriptObservability({
        accountId: input.accountId,
        script,
        accessToken: input.accessToken,
        fetchImpl,
      });
      const next = wireObservabilityDestinations(current, slugs);
      if (!next) continue; // already wired
      const res = await updateScriptObservability({
        accountId: input.accountId,
        script,
        observability: next,
        accessToken: input.accessToken,
        fetchImpl,
      });
      if (res.ok) wired += 1;
      else
        input.log?.warn(
          { script, error: res.error },
          "cloudflare: failed to wire worker observability",
        );
    } catch (e) {
      input.log?.warn(
        { err: e instanceof Error ? e.message : String(e), script },
        "cloudflare: failed to wire worker observability",
      );
    }
  }
  input.log?.info(
    { account_id: input.accountId, scripts: scripts.length, wired },
    "cloudflare: wired worker observability to destinations",
  );
  return { scripts: scripts.length, wired, listOk: true };
}
