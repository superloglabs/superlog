// Render telemetry puller — the ingest half of the Render connector. Render
// has no drains, so instead of the vendor pushing to our intake, this module
// reads logs and infra metrics from Render's REST API for every active
// installation and forwards them (as OTLP JSON) to our own intake,
// authenticated with the installation's project ingest key. Runs as a
// scheduled job (jobs/render-pull.ts): one bounded pass per fire, cursors in
// the installation row make restarts gap- and duplicate-free.
//
// Render rate limits are per user API key: the logs endpoints allow 30
// requests/minute, so logs are read in one batched query per region (all
// resources of a region share a query) with a small page budget per pass;
// metrics GETs (400/minute) are batched per kind across all resources.
//
// IO is behind narrow ports (store + fetch) so the pull logic is unit-testable
// without Postgres or a live Render account.

import {
  RENDER_METRIC_KINDS,
  type RenderLog,
  type RenderMetricSeries,
  type RenderService,
  advanceLogCursor,
  advanceSeriesCursor,
  fetchLogs,
  fetchMetrics,
  fetchServices,
  filterLogsAfterCursor,
  filterSeriesAfterCursor,
  renderLogsToOtlp,
  renderMetricsToOtlp,
  seriesResourceId,
} from "@superlog/render";

export type RenderPullerInstallation = {
  id: string;
  projectId: string;
  renderApiKey: string;
  ownerId: string;
  ownerName: string;
  ingestKey: string | null;
  services: RenderService[];
  logCursor: Record<string, string>;
  metricsCursor: Record<string, number>;
};

export type RenderPullerStore = {
  listActiveInstallations(): Promise<RenderPullerInstallation[]>;
  saveServices(id: string, services: RenderService[]): Promise<void>;
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

export type RenderPullerDeps = {
  store: RenderPullerStore;
  /** Base URL of our proxy intake, e.g. https://intake.superlog.sh */
  intakeBaseUrl: string;
  log: PullerLogger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Max log pages (of `logPageLimit` lines) per region group per pass. */
  logPageBudget?: number;
  /** Log lines per page (Render caps at 100). */
  logPageLimit?: number;
  /** Minimum seconds between metrics polls per installation. */
  metricsIntervalSeconds?: number;
  metricsResolutionSeconds?: number;
  /**
   * Per-installation last-poll clock (epoch seconds), process-lived. Keeps
   * metrics from being polled every pass; on worker restart the worst case is
   * one early poll, deduped by the sample cursor anyway.
   */
  metricsPollState?: Map<string, number>;
};

export type RenderPullStats = {
  installations: number;
  logsForwarded: number;
  metricPointsForwarded: number;
  errors: number;
};

// Metrics polls read a fixed recent window; the per-resource sample cursor
// dedupes overlap between polls.
const METRICS_LOOKBACK_S = 15 * 60;
// Metric resource batching: keep request URLs bounded.
const METRICS_RESOURCE_CHUNK = 25;

export async function runRenderPullOnce(deps: RenderPullerDeps): Promise<RenderPullStats> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const logPageBudget = deps.logPageBudget ?? 5;
  const logPageLimit = deps.logPageLimit ?? 100;
  const metricsInterval = deps.metricsIntervalSeconds ?? 300;
  const resolution = deps.metricsResolutionSeconds ?? 60;
  const pollState = deps.metricsPollState ?? sharedMetricsPollState;
  const intake = deps.intakeBaseUrl.replace(/\/+$/, "");

  const stats: RenderPullStats = {
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
        "render pull failed for installation",
      );
    }
  }
  return stats;

  async function pullInstallation(installation: RenderPullerInstallation): Promise<void> {
    if (!installation.ingestKey) {
      deps.log.warn({ installation_id: installation.id }, "render install has no ingest key");
      return;
    }

    // --- Service inventory --------------------------------------------------
    // Refresh the snapshot every pass so new services start flowing without a
    // reconnect. A revoked key is terminal (Render keys don't refresh): skip
    // and let the user reconnect.
    let services = installation.services;
    const inventory = await fetchServices({
      apiKey: installation.renderApiKey,
      ownerId: installation.ownerId,
      fetchImpl,
    });
    if (inventory.ok) {
      services = inventory.services;
      await deps.store.saveServices(installation.id, inventory.services);
    } else if (inventory.unauthorized) {
      deps.log.warn(
        { installation_id: installation.id },
        "render api key rejected — skipping (user must reconnect)",
      );
      return;
    } else {
      deps.log.warn(
        { installation_id: installation.id, error: inventory.error },
        "render inventory read failed; using stored snapshot",
      );
    }

    const active = services.filter((s) => !s.suspended);
    if (active.length === 0) return;
    const serviceNamesById = Object.fromEntries(active.map((s) => [s.id, s.name]));
    const ctx = {
      serviceNamesById,
      ownerId: installation.ownerId,
      ownerName: installation.ownerName,
    };

    let logCursor = installation.logCursor;
    let metricsCursor = installation.metricsCursor;
    let cursorsDirty = false;

    // --- Logs ---------------------------------------------------------------
    // One query covers every resource in a region (Render requires the batch
    // to share owner + region), so the request count stays flat as services
    // grow: pages consumed ≤ regions × logPageBudget per pass.
    const byRegion = new Map<string, RenderService[]>();
    for (const service of active) {
      const region = service.region ?? "unknown";
      const group = byRegion.get(region);
      if (group) group.push(service);
      else byRegion.set(region, [service]);
    }

    for (const [region, group] of byRegion) {
      const resources = group.map((s) => s.id);
      const cursorTs = logCursor[region];
      const collected: RenderLog[] = [];
      let readOk = true;

      if (!cursorTs) {
        // First pull: one backward read seeds from the most recent lines
        // rather than the beginning of time.
        const read = await fetchLogs({
          apiKey: installation.renderApiKey,
          ownerId: installation.ownerId,
          resources,
          endTime: now().toISOString(),
          limit: logPageLimit,
          fetchImpl,
        });
        if (read.ok) {
          collected.push(...read.page.logs);
        } else {
          readOk = false;
          stats.errors += 1;
          deps.log.warn(
            { installation_id: installation.id, region, error: read.error },
            "render log read failed",
          );
        }
      } else {
        // Forward from the cursor, following Render's timestamp pagination up
        // to the page budget; anything left over is picked up next pass.
        let startTime: string = cursorTs;
        let endTime: string = now().toISOString();
        for (let page = 0; page < logPageBudget; page++) {
          const read = await fetchLogs({
            apiKey: installation.renderApiKey,
            ownerId: installation.ownerId,
            resources,
            startTime,
            endTime,
            direction: "forward",
            limit: logPageLimit,
            fetchImpl,
          });
          if (!read.ok) {
            readOk = false;
            stats.errors += 1;
            deps.log.warn(
              { installation_id: installation.id, region, error: read.error },
              "render log read failed",
            );
            break;
          }
          collected.push(...read.page.logs);
          if (!read.page.hasMore || !read.page.nextStartTime) break;
          startTime = read.page.nextStartTime;
          endTime = read.page.nextEndTime ?? endTime;
        }
      }

      if (readOk) {
        const fresh = filterLogsAfterCursor(logCursor, region, collected);
        const forwarded =
          fresh.length === 0
            ? true
            : await forwardOtlp(
                `${intake}/render/pull/logs`,
                renderLogsToOtlp(fresh, ctx),
                installation.ingestKey,
              );
        if (forwarded) {
          // Seed the cursor even when the first batch is empty so the next
          // pass reads forward instead of re-anchoring.
          const next = advanceLogCursor(logCursor, region, collected);
          const seeded =
            next[region] === undefined ? { ...next, [region]: now().toISOString() } : next;
          if (seeded !== logCursor) {
            logCursor = seeded;
            cursorsDirty = true;
          }
          stats.logsForwarded += fresh.length;
        } else {
          stats.errors += 1;
        }
      }
    }

    // --- Metrics ------------------------------------------------------------
    // One request per kind per resource chunk, gated to one poll per
    // installation per ~5 minutes. Series come back labeled per resource, so
    // the sample cursor is keyed `${resourceId}:${kind}`.
    const nowSec = Math.floor(now().getTime() / 1000);
    const lastPoll = pollState.get(installation.id) ?? 0;
    if (nowSec - lastPoll >= metricsInterval) {
      pollState.set(installation.id, nowSec);
      const startTime = new Date((nowSec - METRICS_LOOKBACK_S) * 1000).toISOString();
      const endTime = now().toISOString();
      const allResources = active.map((s) => s.id);

      for (const kind of RENDER_METRIC_KINDS) {
        for (let i = 0; i < allResources.length; i += METRICS_RESOURCE_CHUNK) {
          const chunk = allResources.slice(i, i + METRICS_RESOURCE_CHUNK);
          const read = await fetchMetrics({
            apiKey: installation.renderApiKey,
            kind,
            resources: chunk,
            startTime,
            endTime,
            resolutionSeconds: resolution,
            fetchImpl,
          });
          if (!read.ok) {
            stats.errors += 1;
            deps.log.warn(
              { installation_id: installation.id, kind, error: read.error },
              "render metrics read failed",
            );
            continue;
          }

          // Dedupe each series against its own resource's cursor, then
          // forward whatever is fresh in one export.
          const freshByKey = new Map<string, RenderMetricSeries[]>();
          for (const series of read.series) {
            const resourceId = seriesResourceId(series);
            if (!resourceId) continue;
            const key = `${resourceId}:${kind}`;
            const fresh = filterSeriesAfterCursor(metricsCursor, key, [series]);
            if (fresh.length === 0) continue;
            const group = freshByKey.get(key);
            if (group) group.push(...fresh);
            else freshByKey.set(key, fresh);
          }
          const freshSeries = [...freshByKey.values()].flat();
          const points = freshSeries.reduce((n, s) => n + s.values.length, 0);
          if (points === 0) continue;

          const forwarded = await forwardOtlp(
            `${intake}/render/pull/metrics`,
            renderMetricsToOtlp(kind, freshSeries, ctx),
            installation.ingestKey,
          );
          if (!forwarded) {
            stats.errors += 1;
            continue;
          }
          for (const [key, group] of freshByKey) {
            metricsCursor = advanceSeriesCursor(metricsCursor, key, group);
          }
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
        deps.log.warn({ url, status: res.status }, "render intake forward rejected");
      }
      return res.ok;
    } catch (err) {
      deps.log.warn(
        { url, err: err instanceof Error ? err.message : String(err) },
        "render intake forward failed",
      );
      return false;
    }
  }
}

const sharedMetricsPollState = new Map<string, number>();
