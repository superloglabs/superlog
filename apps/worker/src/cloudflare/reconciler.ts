// Cloudflare wiring reconcile — the "keep every Worker connected" half of the
// connector, the counterpart to the token keep-alive (refresher.ts).
//
// A Worker only streams to us when its own `observability` config lists our
// destination, and that per-Worker link is set once at connect. So a Worker
// created, recreated, or renamed after connect comes up UNWIRED and goes dark —
// nothing notices; the account still shows "connected". This job closes that
// gap: for every installation with auto-wire on, it re-runs the idempotent wire
// pass (ensure our slugs are merged into each Worker's observability), picking up
// any drifted / new / recreated Worker automatically.
//
// The reconcile cadence is the max data-loss window for a newly-unwired Worker —
// Cloudflare doesn't backfill telemetry for the dark period — so it runs hourly
// (see jobs/cloudflare-reconcile.ts), much tighter than the daily token refresh.
//
// IO is behind a narrow store port + injectable fetch/reconcile so the logic is
// unit-testable without Postgres or a live Cloudflare account.

import type { WorkerDestinationSlugs } from "@superlog/cloudflare";

/** One installation to reconcile: the account + the destination slugs to wire. */
export type CloudflareReconcileInstallation = {
  id: string;
  accountId: string;
  slugs: WorkerDestinationSlugs;
};

export type CloudflareReconcilerStore = {
  /** Active installs with auto-wire on (revoked and manual-wiring installs excluded). */
  listAutoWireInstallations(): Promise<CloudflareReconcileInstallation[]>;
  /**
   * A usable access token for the install, refreshing under the per-install
   * advisory lock when the stored one is near expiry (the SAME lock the api and
   * the keep-alive take, so a rotating refresh token is never redeemed twice).
   * Returns null when there's no usable grant (legacy install with no refresh
   * token and an expired access token, or a dead grant) — that install needs a
   * manual reconnect and is skipped. Throws ONLY on a DB/persist/lock failure,
   * which aborts the pass (a refresh that rotated the token but couldn't be saved
   * must not be silently continued past, and the DB issue would hit every
   * remaining install too).
   */
  freshAccessToken(installationId: string): Promise<string | null>;
};

/** The wiring pass — injected so tests don't hit Cloudflare (prod: reconcileWorkerWiring). */
export type WorkerWiringFn = (input: {
  accountId: string;
  accessToken: string;
  slugs: WorkerDestinationSlugs;
  fetchImpl?: typeof fetch;
  log?: {
    info(f: Record<string, unknown>, m: string): void;
    warn(f: Record<string, unknown>, m: string): void;
  };
}) => Promise<{ scripts: number; wired: number; listOk: boolean }>;

type ReconcilerLogger = {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
};

export type CloudflareReconcilerDeps = {
  store: CloudflareReconcilerStore;
  reconcile: WorkerWiringFn;
  log: ReconcilerLogger;
  fetchImpl?: typeof fetch;
};

export type CloudflareReconcileStats = {
  installations: number;
  reconciled: number;
  workersWired: number;
  skipped: number;
  errors: number;
};

export async function runCloudflareReconcileOnce(
  deps: CloudflareReconcilerDeps,
): Promise<CloudflareReconcileStats> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stats: CloudflareReconcileStats = {
    installations: 0,
    reconciled: 0,
    workersWired: 0,
    skipped: 0,
    errors: 0,
  };

  const installations = await deps.store.listAutoWireInstallations();
  for (const inst of installations) {
    stats.installations += 1;

    let accessToken: string | null;
    try {
      accessToken = await deps.store.freshAccessToken(inst.id);
    } catch (err) {
      // DB/persist/lock failure (see freshAccessToken doc): abort the pass rather
      // than risk rotating-and-losing tokens across the remaining installs.
      // pg-boss retries the job.
      stats.errors += 1;
      deps.log.error(
        {
          installation_id: inst.id,
          account_id: inst.accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "cloudflare reconcile: token access failed; aborting pass",
      );
      throw err;
    }

    // No usable grant → the install needs a manual reconnect; skip it (counted so
    // we can see how many are stuck).
    if (!accessToken) {
      stats.skipped += 1;
      continue;
    }

    try {
      const { wired } = await deps.reconcile({
        accountId: inst.accountId,
        accessToken,
        slugs: inst.slugs,
        fetchImpl,
        log: deps.log,
      });
      stats.reconciled += 1;
      stats.workersWired += wired;
    } catch (err) {
      // reconcileWorkerWiring is per-Worker isolated and shouldn't throw, but a
      // stray failure for one install must not sink the whole pass — the CF-side
      // wiring rotated nothing, so isolating it is safe.
      stats.errors += 1;
      deps.log.error(
        {
          installation_id: inst.id,
          account_id: inst.accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "cloudflare reconcile: wiring pass failed for install; skipping",
      );
    }
  }

  return stats;
}
