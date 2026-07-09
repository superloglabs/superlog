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
// window, and one refresh per install per day is negligible. There's no
// per-access-token-expiry gate — the daily schedule is the rate limit, and the
// point is to keep the grant alive, not to chase the 16h access-token expiry.
//
// IO is behind a narrow store port + injectable fetch so the logic is
// unit-testable without Postgres or a live Cloudflare account.

import { type CloudflareClientCredentials, refreshAccessToken } from "@superlog/cloudflare";

export type CloudflareRefreshInstallation = {
  id: string;
  projectId: string;
  accountId: string;
  refreshToken: string | null;
};

export type CloudflareRefreshedTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

export type CloudflareRefresherStore = {
  /** Active installs eligible for keep-alive (not revoked). */
  listActiveInstallations(): Promise<CloudflareRefreshInstallation[]>;
  /** Persist a refreshed (rotated!) token pair immediately. */
  saveTokens(id: string, tokens: CloudflareRefreshedTokens): Promise<void>;
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
    if (!inst.refreshToken) {
      stats.skipped += 1;
      continue;
    }

    // The token request and the persist have DIFFERENT failure semantics, so
    // they're handled separately:
    //
    // A refresh failure ({ ok: false } or a thrown fetch) is isolated to this
    // install — nothing was rotated, so skip it and carry on with the rest.
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      refreshed = await refreshAccessToken({
        config: deps.config,
        refreshToken: inst.refreshToken,
        fetchImpl,
      });
    } catch (err) {
      stats.errors += 1;
      deps.log.error(
        {
          installation_id: inst.id,
          account_id: inst.accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "cloudflare token request threw; skipping install",
      );
      continue;
    }
    if (!refreshed.ok) {
      // A dead grant (expired / revoked) surfaces here. Log and move on — the
      // connection just needs a manual reconnect.
      stats.errors += 1;
      deps.log.error(
        { installation_id: inst.id, account_id: inst.accountId, error: refreshed.error },
        "cloudflare token refresh failed",
      );
      continue;
    }

    // The refresh SUCCEEDED, so Cloudflare has already rotated (consumed) the
    // old refresh token. Persisting the replacement is now mandatory — if the
    // save fails the install is stranded, and a save failure is a DB problem
    // that would hit every remaining install too (each rotating then losing its
    // new token). So abort the whole pass on a save failure instead of bricking
    // the rest; pg-boss retries the job.
    try {
      await deps.store.saveTokens(inst.id, {
        accessToken: refreshed.accessToken,
        // Rotating refresh tokens: keep the replacement, falling back to the
        // existing one when the response didn't rotate it.
        refreshToken: refreshed.refreshToken ?? inst.refreshToken,
        tokenExpiresAt:
          refreshed.expiresIn != null
            ? new Date(now().getTime() + refreshed.expiresIn * 1000)
            : null,
      });
    } catch (err) {
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
    stats.refreshed += 1;
  }

  return stats;
}
