import process from "node:process";
import { asc, eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import {
  type AlertComparator,
  type AlertFiring,
  alertEpisodes,
  alertFirings,
  alerts,
  incidentIssues,
} from "./schema.js";

// Reconstructs `alert_episodes` from the historical `alert_firings` tick log.
//
// An episode is a contiguous run of `firing` ticks for one (alert, groupKey),
// opened on the first firing tick and closed on the next `ok` tick (or left
// open if the alert is still firing). This walks every alert's firing history,
// rebuilds those runs, links each to the issue/incident it raised, and inserts
// the episodes the live evaluation loop would have written had episodes existed
// at the time.
//
// Idempotent: any alert that already has at least one episode row is skipped,
// so re-running is safe. Pass `--dry-run` to report without inserting.
//
//   pnpm --filter @superlog/db exec tsx src/backfill-alert-episodes.ts [--dry-run]

const DRY_RUN = process.argv.includes("--dry-run");

function moreSevereValue(prev: number, next: number, comparator: AlertComparator): number {
  return comparator === "gt" ? Math.max(prev, next) : Math.min(prev, next);
}

type BuiltEpisode = {
  groupKey: string;
  startedAt: Date;
  endedAt: Date | null;
  openObservedValue: number;
  peakObservedValue: number;
  lastObservedValue: number;
  lastFiringAt: Date;
  issueId: string | null;
};

// Walk one (alert, group) firing series in time order, emitting one episode per
// contiguous firing run.
function buildEpisodesForGroup(firings: AlertFiring[], comparator: AlertComparator): BuiltEpisode[] {
  const episodes: BuiltEpisode[] = [];
  let open: BuiltEpisode | null = null;

  for (const f of firings) {
    if (f.state === "firing") {
      if (!open) {
        open = {
          groupKey: f.groupKey,
          startedAt: f.evaluatedAt,
          endedAt: null,
          openObservedValue: f.observedValue,
          peakObservedValue: f.observedValue,
          lastObservedValue: f.observedValue,
          lastFiringAt: f.evaluatedAt,
          issueId: f.issueId,
        };
      } else {
        open.peakObservedValue = moreSevereValue(open.peakObservedValue, f.observedValue, comparator);
        open.lastObservedValue = f.observedValue;
        open.lastFiringAt = f.evaluatedAt;
        if (!open.issueId && f.issueId) open.issueId = f.issueId;
      }
    } else if (open) {
      open.endedAt = f.evaluatedAt;
      episodes.push(open);
      open = null;
    }
  }
  if (open) episodes.push(open);
  return episodes;
}

async function main(): Promise<void> {
  const allAlerts = await db
    .select({ id: alerts.id, projectId: alerts.projectId, comparator: alerts.comparator })
    .from(alerts);

  let processed = 0;
  let skipped = 0;
  let written = 0;

  for (const alert of allAlerts) {
    const existing = await db.query.alertEpisodes.findFirst({
      where: eq(alertEpisodes.alertId, alert.id),
      columns: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const firings = await db.query.alertFirings.findMany({
      where: eq(alertFirings.alertId, alert.id),
      orderBy: [asc(alertFirings.groupKey), asc(alertFirings.evaluatedAt)],
    });
    if (firings.length === 0) {
      processed += 1;
      continue;
    }

    const byGroup = new Map<string, AlertFiring[]>();
    for (const f of firings) {
      const arr = byGroup.get(f.groupKey) ?? [];
      arr.push(f);
      byGroup.set(f.groupKey, arr);
    }

    const built: BuiltEpisode[] = [];
    for (const series of byGroup.values()) {
      built.push(...buildEpisodesForGroup(series, alert.comparator));
    }
    if (built.length === 0) {
      processed += 1;
      continue;
    }

    // Resolve the incident each episode's issue maps to (1:1 via incident_issues).
    const rows: (typeof alertEpisodes.$inferInsert)[] = [];
    for (const ep of built) {
      let incidentId: string | null = null;
      if (ep.issueId) {
        const link = await db.query.incidentIssues.findFirst({
          where: eq(incidentIssues.issueId, ep.issueId),
          columns: { incidentId: true },
        });
        incidentId = link?.incidentId ?? null;
      }
      rows.push({
        alertId: alert.id,
        projectId: alert.projectId,
        groupKey: ep.groupKey,
        state: ep.endedAt ? "resolved" : "firing",
        startedAt: ep.startedAt,
        endedAt: ep.endedAt,
        openObservedValue: ep.openObservedValue,
        peakObservedValue: ep.peakObservedValue,
        lastObservedValue: ep.lastObservedValue,
        lastFiringAt: ep.lastFiringAt,
        issueId: ep.issueId,
        incidentId,
      });
    }

    if (!DRY_RUN) await db.insert(alertEpisodes).values(rows);
    written += rows.length;
    processed += 1;
    console.log(`alert ${alert.id}: ${DRY_RUN ? "would write" : "wrote"} ${rows.length} episode(s)`);
  }

  console.log(
    `\n${DRY_RUN ? "[dry-run] " : ""}done — alerts processed=${processed} skipped(existing)=${skipped} episodes=${written}`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
