// Backfill for the incidents+investigations merge (PR: merge incidents and
// investigations into a single user-facing concept; agent runs become a
// behind-the-scenes execution wrapper).
//
// The Drizzle migration (0047_tense_calypso.sql) handles schema renames in
// place — investigations→agent_runs, investigation_events→incident_events,
// the investigation_id→agent_run_id columns, etc. — but it can't rewrite
// data values. This script does three things:
//
//   1. incident_events.kind values: the worker now emits "agent_run_*"
//      kinds, but historical rows say "investigation_*". Rewrite them so
//      timeline rendering is consistent regardless of when the row was
//      written.
//
//   2. webhook_endpoints.enabled_events / webhook_deliveries.event_type:
//      "investigation.completed" → "agent_run.completed". Customer-facing
//      breaking change; the column default already flipped in migration.
//
//   3. Flatten findings from each incident's latest successful agent run
//      onto the new incident columns (agent_summary, root_cause_text +
//      confidence, estimated_impact_text + confidence, suggested_severity,
//      noise_classification, resolution_classification, findings_agent_run_id).
//      The worker writes these on every new completion going forward;
//      this seeds them from the existing agent_runs.result jsonb so the
//      UI doesn't have to fall back to the legacy field.
//
// Run with:
//   pnpm tsx scripts/backfill-merge-incidents-agent-runs.ts --dry-run
//   pnpm tsx scripts/backfill-merge-incidents-agent-runs.ts --apply
//
// Always --dry-run first against prod, review counts, then --apply.

import process from "node:process";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

const EVENT_KIND_RENAMES: Record<string, string> = {
  investigation_queued: "agent_run_queued",
  investigation_started: "agent_run_started",
  investigation_completed: "agent_run_completed",
  investigation_restarted: "agent_run_restarted",
  investigation_superseded: "agent_run_superseded",
};

type Finding = {
  state?: string;
  summary?: string | null;
  rootCause?: { text?: string; confidence?: number } | null;
  estimatedImpact?: { text?: string; confidence?: number } | null;
  severity?: string | null;
  noiseClassification?: unknown;
  resolutionClassification?: unknown;
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const apply = process.argv.includes("--apply");
  const dry = !apply;

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  // ─── 1. incident_events.kind ─────────────────────────────────────────
  const kindCounts: Record<string, number> = {};
  for (const [oldKind, newKind] of Object.entries(EVENT_KIND_RENAMES)) {
    const matching = await db
      .select({ id: schema.incidentEvents.id })
      .from(schema.incidentEvents)
      .where(eq(schema.incidentEvents.kind, oldKind));
    kindCounts[`${oldKind} → ${newKind}`] = matching.length;
    if (!dry && matching.length > 0) {
      await db
        .update(schema.incidentEvents)
        .set({ kind: newKind })
        .where(eq(schema.incidentEvents.kind, oldKind));
    }
  }

  // ─── 2. webhook event type ───────────────────────────────────────────
  // webhook_deliveries.event_type is a plain text column; webhook_endpoints
  // .enabled_events is a jsonb array. Both need rewriting in-place.
  const deliveryMatches = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.eventType, "investigation.completed" as never));
  const deliveryCount = deliveryMatches.length;
  if (!dry && deliveryCount > 0) {
    await db
      .update(schema.webhookDeliveries)
      .set({ eventType: "agent_run.completed" })
      .where(eq(schema.webhookDeliveries.eventType, "investigation.completed" as never));
  }

  // webhook_endpoints.enabled_events: jsonb array; rewrite any occurrence
  // of "investigation.completed" → "agent_run.completed" while preserving
  // ordering and other (future) event types.
  const allEndpoints = await db.select().from(schema.webhookEndpoints);
  let endpointCount = 0;
  for (const ep of allEndpoints) {
    if (!ep.enabledEvents.includes("investigation.completed" as never)) continue;
    endpointCount += 1;
    if (!dry) {
      const next = ep.enabledEvents.map((e) =>
        (e as string) === "investigation.completed" ? ("agent_run.completed" as const) : e,
      );
      await db
        .update(schema.webhookEndpoints)
        .set({ enabledEvents: next as never })
        .where(eq(schema.webhookEndpoints.id, ep.id));
    }
  }

  // ─── 3. Flatten findings onto incidents ──────────────────────────────
  // Pick the most recent COMPLETED agent_run per incident — filter at the
  // SQL layer so an incident whose newest run is still in-flight or
  // failed doesn't silently skip findings flattening when an older
  // completed run would have served just fine.
  const incidents = await db.select({ id: schema.incidents.id }).from(schema.incidents);
  let findingsApplied = 0;
  let findingsSkipped = 0;
  for (const incident of incidents) {
    const [latest] = await db
      .select()
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.incidentId, incident.id),
          eq(schema.agentRuns.state, "complete"),
          isNotNull(schema.agentRuns.result),
        ),
      )
      .orderBy(desc(schema.agentRuns.completedAt))
      .limit(1);
    if (!latest || !latest.result) {
      findingsSkipped += 1;
      continue;
    }
    const r = latest.result as Finding;
    findingsApplied += 1;
    if (!dry) {
      await db
        .update(schema.incidents)
        .set({
          agentSummary: r.summary ?? null,
          rootCauseText: r.rootCause?.text ?? null,
          rootCauseConfidence: r.rootCause?.confidence ?? null,
          estimatedImpactText: r.estimatedImpact?.text ?? null,
          estimatedImpactConfidence: r.estimatedImpact?.confidence ?? null,
          suggestedSeverity: (r.severity ?? null) as never,
          noiseClassification: (r.noiseClassification ?? null) as never,
          resolutionClassification: (r.resolutionClassification ?? null) as never,
          findingsAgentRunId: latest.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.incidents.id, incident.id));
    }
  }

  console.log(`${dry ? "DRY RUN" : "APPLIED"}:`);
  console.log("  incident_events.kind rewrites:");
  for (const [k, v] of Object.entries(kindCounts)) console.log(`    ${k}: ${v}`);
  console.log(`  webhook_deliveries.event_type rewrites: ${deliveryCount}`);
  console.log(`  webhook_endpoints.enabled_events rewrites: ${endpointCount}`);
  console.log(
    `  incidents with findings flattened: ${findingsApplied} (${findingsSkipped} had no completed agent run)`,
  );
  if (dry) console.log("\nRe-run with --apply to write the changes.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
