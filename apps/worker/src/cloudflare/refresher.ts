// Cloudflare OAuth keep-alive — the maintenance half of the Cloudflare
// connector. The connector is push-only (Workers Observability streams straight
// to our intake), so unlike Railway we don't poll for telemetry, and after
// connect we almost never call the Cloudflare API. That's the problem this
// solves: the delegated grant's refresh token is bounded by the OAuth client's
// "grant session duration" (Cloudflare caps it at one month) and it ROTATES on
// every use, so if it's never exercised it just ages out and the connection
// goes dark again — only later. Nothing else would notice; the UI still says
// "connected".
//
// So this runs as a scheduled job (jobs/cloudflare-refresh.ts) and, once a day,
// exercises every active installation's refresh token: mint a fresh access
// token and persist the rotated pair. Daily is well inside the one-month
// window, and one refresh per install per day is negligible.
//
// Each refresh runs inside a per-installation lock provided by the store
// (`withLockedInstallation`) — the SAME advisory lock the api's on-demand
// refresh takes — so a rotating refresh token is never redeemed twice
// concurrently (which would reject the loser and, under reuse detection, revoke
// the whole grant). The token is re-read under the lock, so if another actor
// just refreshed it we reuse theirs instead of redeeming again.
//
// IO is behind a narrow store port + injectable fetch so the logic is
// unit-testable without Postgres or a live Cloudflare account.

import {
  type CloudflareClientCredentials,
  type CloudflareTokenResult,
  refreshAccessToken,
} from "@superlog/cloudflare";

/** Minimal per-install summary for the pass (no secrets decrypted up front). */
export type CloudflareRefreshInstallation = {
  id: string;
  accountId: string;
  hasRefreshToken: boolean;
};

/** Current token state, re-read under the lock. */
export type CloudflareInstallationTokens = {
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

export type CloudflareRefreshedTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

export type CloudflareRefresherStore = {
  /** Active installs eligible for keep-alive (not revoked). */
  listActiveInstallations(): Promise<CloudflareRefreshInstallation[]>;
  /**
   * Run `fn` while holding a per-installation advisory lock (the same lock the
   * api's freshAccessToken takes). `fn` receives the tokens re-read under the
   * lock and a `save` that persists within the same locked transaction. The
   * whole thing is one transaction, so `save` failing rolls back and propagates.
   */
  withLockedInstallation<T>(
    installationId: string,
    fn: (
      current: CloudflareInstallationTokens | null,
      save: (tokens: CloudflareRefreshedTokens) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
};

type RefresherLogger = {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
};

export type CloudflareRefresherDeps = {
  store: CloudflareRefresherStore;
  config: CloudflareClientCredentials;
  log: RefresherLogger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type CloudflareRefreshStats = {
  installations: number;
  refreshed: number;
  skipped: number;
  errors: number;
};

// Skip the redeem only when a comfortably-valid access token already exists —
// i.e. another actor (the api's on-demand refresh) just refreshed it. Access
// tokens are ~16h and the job runs daily, so under normal operation the token
// is always past this and gets refreshed, keeping the grant alive.
const STILL_FRESH_MARGIN_MS = 60 * 1000;

type RefreshOutcome = "refreshed" | "already_fresh" | "no_token" | "rejected";

export async function runCloudflareRefreshOnce(
  deps: CloudflareRefresherDeps,
): Promise<CloudflareRefreshStats> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const stats: CloudflareRefreshStats = {
    installations: 0,
    refreshed: 0,
    skipped: 0,
    errors: 0,
  };

  const installations = await deps.store.listActiveInstallations();
  for (const inst of installations) {
    stats.installations += 1;

    // No refresh token: a legacy install (Cloudflare issued none before the
    // offline grant was enabled). Nothing to exercise — the user must reconnect.
    if (!inst.hasRefreshToken) {
      stats.skipped += 1;
      continue;
    }

    let outcome: RefreshOutcome;
    try {
      outcome = await deps.store.withLockedInstallation(inst.id, (current, save) =>
        refreshOne(inst, current, save),
      );
    } catch (err) {
      // Only a persist/DB/lock failure reaches here (a failed token request is
      // handled inside and returned as "rejected"). A successful refresh has
      // already rotated the token on Cloudflare's side, so a save failure means
      // the replacement is lost — and it's a DB problem that would hit every
      // remaining install too. Abort the pass rather than rotate-and-lose across
      // all of them; pg-boss retries the job.
      stats.errors += 1;
      deps.log.error(
        {
          installation_id: inst.id,
          account_id: inst.accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "cloudflare token save failed after refresh; aborting pass to avoid discarding rotated tokens across installs",
      );
      throw err;
    }

    if (outcome === "refreshed") stats.refreshed += 1;
    else if (outcome === "rejected") stats.errors += 1;
    else stats.skipped += 1; // no_token | already_fresh
  }

  return stats;

  // Runs under the installation lock, against tokens re-read inside it.
  async function refreshOne(
    inst: CloudflareRefreshInstallation,
    current: CloudflareInstallationTokens | null,
    save: (tokens: CloudflareRefreshedTokens) => Promise<void>,
  ): Promise<RefreshOutcome> {
    if (!current || !current.refreshToken) return "no_token";
    // Another actor refreshed it while we waited for the lock — leave it.
    const expiresAt = current.tokenExpiresAt?.getTime() ?? null;
    if (expiresAt !== null && expiresAt - now().getTime() > STILL_FRESH_MARGIN_MS) {
      return "already_fresh";
    }

    let refreshed: CloudflareTokenResult;
    try {
      refreshed = await refreshAccessToken({
        config: deps.config,
        refreshToken: current.refreshToken,
        fetchImpl,
      });
    } catch (err) {
      // A thrown fetch (network / DNS) didn't rotate anything — isolate it.
      deps.log.error(
        {
          installation_id: inst.id,
          account_id: inst.accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "cloudflare token request threw; skipping install",
      );
      return "rejected";
    }
    if (!refreshed.ok) {
      // A dead grant (expired / revoked) surfaces here — needs manual reconnect.
      deps.log.error(
        { installation_id: inst.id, account_id: inst.accountId, error: refreshed.error },
        "cloudflare token refresh failed",
      );
      return "rejected";
    }

    // Refresh succeeded → the old token is consumed; persisting the replacement
    // is mandatory. A throw from `save` propagates out and aborts the pass.
    await save({
      accessToken: refreshed.accessToken,
      // Rotating refresh tokens: keep the replacement, falling back to the
      // existing one when the response didn't rotate it.
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      tokenExpiresAt:
        refreshed.expiresIn != null ? new Date(now().getTime() + refreshed.expiresIn * 1000) : null,
    });
    return "refreshed";
  }
}
