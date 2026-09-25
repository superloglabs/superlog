// Railway telemetry puller — the ingest half of the Railway connector.
// Railway has no drains, so instead of the vendor pushing to our intake, this
// module reads logs and infra metrics from Railway's GraphQL API for every
// active installation and forwards them (as OTLP JSON) to our own intake,
// authenticated with the installation's project ingest key. Runs as a
// scheduled job (jobs/railway-pull.ts): one bounded pass per fire, cursors in
// the installation row make restarts gap- and duplicate-free.
//
// IO is behind narrow ports (store + fetch) so the pull logic is unit-testable
// without Postgres or a live Railway account.

import {
  type RailwayGrantedProject,
  type RailwayOAuthConfig,
  advanceLogCursor,
  advanceMetricsCursor,
  fetchEnvironmentLogs,
  fetchGrantedProjects,
  fetchProjectInventory,
  fetchServiceMetrics,
  filterLogsAfterCursor,
  filterMetricsAfterCursor,
  railwayLogsToOtlp,
  railwayMetricsToOtlp,
  refreshAccessToken,
} from "@superlog/railway";

export type RailwayPullerInstallation = {
  id: string;
  projectId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  ingestKey: string | null;
  grantedProjects: RailwayGrantedProject[];
  logCursor: Record<string, string>;
  metricsCursor: Record<string, number>;
};

export type RailwayPullerStore = {
  listActiveInstallations(): Promise<RailwayPullerInstallation[]>;
  /** Persist a refreshed (rotated!) token pair immediately. */
  saveTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | null; tokenExpiresAt: Date | null },
  ): Promise<void>;
  saveGrantedProjects(id: string, projects: RailwayGrantedProject[]): Promise<void>;
  saveCursors(
    id: string,
    cursors: { logCursor: Record<string, string>; metricsCursor: Record<string, number> },
  ): Promise<void>;
};

type PullerLogger = {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
};

export type RailwayPullerDeps = {
  store: RailwayPullerStore;
  config: RailwayOAuthConfig;
  /** Base URL of our proxy intake, e.g. https://intake.superlog.sh */
  intakeBaseUrl: string;
  log: PullerLogger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Max log lines per environment per pass. */
  logBatchLimit?: number;
  /**
   * Max log lines per environment on the very first pull (no prior cursor).
   * Kept small to avoid a large historical backfill creating a burst of
   * issue transitions that saturates the LLM-grouping queue when a new
   * installation connects with many projects/environments. Subsequent passes
   * advance the cursor and use logBatchLimit to catch up incrementally.
   */
  firstPullLogBatchLimit?: number;
  /** Minimum seconds between metrics polls per service. */
  metricsIntervalSeconds?: number;
  metricsSampleRateSeconds?: number;
  /**
   * Per-service last-poll clock (epoch seconds), process-lived. Keeps idle
   * services from being polled every pass; on worker restart the worst case is
   * one early poll per service, deduped by the sample cursor anyway.
   */
  metricsPollState?: Map<string, number>;
};

export type RailwayPullStats = {
  installations: number;
  logsForwarded: number;
  metricPointsForwarded: number;
  errors: number;
};

// Refresh when less than this remains — one pass must never outlive the token.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// First pull seeds from recent history rather than the beginning of time.
const METRICS_FIRST_LOOKBACK_S = 15 * 60;
const METRICS_MAX_LOOKBACK_S = 30 * 60;

export async function runRailwayPullOnce(deps: RailwayPullerDeps): Promise<RailwayPullStats> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const logBatchLimit = deps.logBatchLimit ?? 1000;
  // First-pull environments get a much smaller cap so a new installation
  // with many environments cannot dump thousands of historical log lines in
  // one pass and saturate the issue-transition grouping queue.
  const firstPullLogBatchLimit = deps.firstPullLogBatchLimit ?? 50;
  const metricsInterval = deps.metricsIntervalSeconds ?? 300;
  const sampleRate = deps.metricsSampleRateSeconds ?? 60;
  const pollState = deps.metricsPollState ?? sharedMetricsPollState;
  const intake = deps.intakeBaseUrl.replace(/\/+$/, "");

  const stats: RailwayPullStats = {
    installations: 0,
    logsForwarded: 0,
    metricPointsForwarded: 0,
    errors: 0,
  };

  const installations = await deps.store.listActiveInstallations();
  for (const installation of installations) {
    stats.installations += 1;
    try {
      await pullInstallation(installation);
    } catch (err) {
      stats.errors += 1;
      deps.log.error(
        { installation_id: installation.id, err: err instanceof Error ? err.message : String(err) },
        "railway pull failed for installation",
      );
    }
  }
  return stats;

  async function pullInstallation(installation: RailwayPullerInstallation): Promise<void> {
    if (!installation.ingestKey) {
      deps.log.warn({ installation_id: installation.id }, "railway install has no ingest key");
      return;
    }

    // --- Token freshness -------------------------------------------------
    let accessToken = installation.accessToken;
    const expiresAt = installation.tokenExpiresAt?.getTime() ?? null;
    if (expiresAt !== null && expiresAt - now().getTime() < TOKEN_REFRESH_MARGIN_MS) {
      if (!installation.refreshToken) {
        deps.log.warn(
          { installation_id: installation.id },
          "railway token expiring and no refresh token — skipping (user must reconnect)",
        );
        return;
      }
      const refreshed = await refreshAccessToken({
        config: deps.config,
        refreshToken: installation.refreshToken,
        fetchImpl,
      });
      if (!refreshed.ok) {
        stats.errors += 1;
        deps.log.error(
          { installation_id: installation.id, error: refreshed.error },
          "railway token refresh failed",
        );
        return;
      }
      accessToken = refreshed.accessToken;
      // Rotating refresh tokens: persist the replacement before doing anything
      // else — losing it would strand the installation at access-token expiry.
      await deps.store.saveTokens(installation.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? installation.refreshToken,
        tokenExpiresAt: refreshed.expiresInSeconds
          ? new Date(now().getTime() + refreshed.expiresInSeconds * 1000)
          : null,
      });
    }

    // --- Grant snapshot ---------------------------------------------------
    let grantedProjects = installation.grantedProjects;
    const granted = await fetchGrantedProjects({ accessToken, fetchImpl });
    if (granted.ok) {
      grantedProjects = granted.projects;
      await deps.store.saveGrantedProjects(installation.id, granted.projects);
    } else {
      deps.log.warn(
        { installation_id: installation.id, error: granted.error },
        "railway grant refresh failed; using stored snapshot",
      );
    }

    let logCursor = installation.logCursor;
    let metricsCursor = installation.metricsCursor;
    let cursorsDirty = false;

    for (const project of grantedProjects) {
      const inventory = await fetchProjectInventory({
        accessToken,
        projectId: project.id,
        fetchImpl,
      });
      if (!inventory.ok) {
        stats.errors += 1;
        deps.log.warn(
          { installation_id: installation.id, railway_project: project.id, error: inventory.error },
          "railway inventory read failed; skipping project this pass",
        );
        continue;
      }
      const serviceNamesById = Object.fromEntries(inventory.services.map((s) => [s.id, s.name]));

      for (const environment of inventory.environments) {
        const ctx = {
          serviceNamesById,
          projectId: project.id,
          projectName: project.name,
          environmentId: environment.id,
          environmentName: environment.name,
        };

        // --- Logs ---------------------------------------------------------
        const cursorTs = logCursor[environment.id];
        // Use a smaller limit when there is no prior cursor: this is the
        // first pull for this environment and we anchor backward from now,
        // so a large limit would backfill thousands of historical lines in
        // one pass and saturate the issue-transition grouping queue.
        const effectiveLogLimit = cursorTs ? logBatchLimit : firstPullLogBatchLimit;
        const logsRead = await fetchEnvironmentLogs({
          accessToken,
          environmentId: environment.id,
          ...(cursorTs ? { afterDate: cursorTs } : { anchorDate: now().toISOString() }),
          limit: effectiveLogLimit,
          fetchImpl,
        });
        if (!logsRead.ok) {
          stats.errors += 1;
          deps.log.warn(
            {
              installation_id: installation.id,
              environment_id: environment.id,
              error: logsRead.error,
            },
            "railway log read failed",
          );
        } else {
          const fresh = filterLogsAfterCursor(logCursor, environment.id, logsRead.logs);
          const forwarded =
            fresh.length === 0
              ? true
              : await forwardOtlp(
                  `${intake}/railway/pull/logs`,
                  railwayLogsToOtlp(fresh, ctx),
                  installation.ingestKey,
                );
          if (forwarded) {
            // Seed the cursor even when the first batch is empty so the next
            // pass reads forward instead of re-anchoring.
            const next = advanceLogCursor(logCursor, environment.id, logsRead.logs);
            const seeded =
              next[environment.id] === undefined
                ? { ...next, [environment.id]: now().toISOString() }
                : next;
            if (seeded !== logCursor) {
              logCursor = seeded;
              cursorsDirty = true;
            }
            stats.logsForwarded += fresh.length;
          } else {
            stats.errors += 1;
          }
        }

        // --- Metrics --------------------------------------------------------
        for (const service of inventory.services) {
          // Metrics are read per (environment, service) — a service deployed
          // to several environments has independent series, so both the poll
          // clock and the sample cursor must be keyed by the pair or the
          // second environment starves / dedupes against the first.
          const envServiceKey = `${environment.id}:${service.id}`;
          const pollKey = `${installation.id}:${envServiceKey}`;
          const nowSec = Math.floor(now().getTime() / 1000);
          const lastPoll = pollState.get(pollKey) ?? 0;
          if (nowSec - lastPoll < metricsInterval) continue;
          pollState.set(pollKey, nowSec);

          const lastSample = metricsCursor[envServiceKey];
          const startSec = lastSample
            ? Math.max(lastSample + 1, nowSec - METRICS_MAX_LOOKBACK_S)
            : nowSec - METRICS_FIRST_LOOKBACK_S;
          const metricsRead = await fetchServiceMetrics({
            accessToken,
            environmentId: environment.id,
            serviceId: service.id,
            startDate: new Date(startSec * 1000).toISOString(),
            endDate: now().toISOString(),
            sampleRateSeconds: sampleRate,
            fetchImpl,
          });
          if (!metricsRead.ok) {
            stats.errors += 1;
            deps.log.warn(
              {
                installation_id: installation.id,
                service_id: service.id,
                error: metricsRead.error,
              },
              "railway metrics read failed",
            );
            continue;
          }
          const freshResults = filterMetricsAfterCursor(
            metricsCursor,
            envServiceKey,
            metricsRead.results,
          );
          const points = freshResults.reduce((n, r) => n + r.values.length, 0);
          if (points === 0) continue;
          const forwarded = await forwardOtlp(
            `${intake}/railway/pull/metrics`,
            railwayMetricsToOtlp(freshResults, { ...ctx, serviceId: service.id }),
            installation.ingestKey,
          );
          if (!forwarded) {
            stats.errors += 1;
            continue;
          }
          metricsCursor = advanceMetricsCursor(metricsCursor, envServiceKey, freshResults);
          cursorsDirty = true;
          stats.metricPointsForwarded += points;
        }
      }
    }

    if (cursorsDirty) {
      await deps.store.saveCursors(installation.id, { logCursor, metricsCursor });
    }
  }

  async function forwardOtlp(url: string, payload: unknown, ingestKey: string): Promise<boolean> {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ingestKey },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        deps.log.warn({ url, status: res.status }, "railway intake forward rejected");
      }
      return res.ok;
    } catch (err) {
      deps.log.warn(
        { url, err: err instanceof Error ? err.message : String(err) },
        "railway intake forward failed",
      );
      return false;
    }
  }
}

const sharedMetricsPollState = new Map<string, number>();
