// One-off: marks 19 Trellis incidents as autoresolved_noise with classification
// reasons derived from the agent agentRun summaries we already have on
// disk. This is a backfill for the autoresolved_noise feature shipped on
// 2026-04-29; future agent_runs will set this themselves via the agent's
// new noiseClassification result block.
//
// Each codename below was hand-classified after reading the existing
// agentRun summary for that incident — the agent already concluded "no
// user-facing impact" or equivalent in every case. Reasons follow the enum in
// packages/db/src/schema.ts:IncidentNoiseReason.
//
// Usage:
//   railway run --service worker pnpm tsx scripts/backfill-trellis-noise.ts --dry-run
//   railway run --service worker pnpm tsx scripts/backfill-trellis-noise.ts --apply
import process from "node:process";
import { and, eq, inArray } from "drizzle-orm";
import type { IncidentNoiseReason } from "../packages/db/src/schema.js";

const TRELLIS_PROJECT_ID = "f0686143-a9a5-49bb-98ea-68da227dad07";

type Classification = {
  codename: string;
  reason: IncidentNoiseReason;
  // One-line justification quoting from the agent's existing agent run
  // summary — the same evidence the agent's noiseClassification.evidence field
  // would have carried had the feature existed when the incident was opened.
  evidence: string;
};

const CLASSIFICATIONS: Classification[] = [
  // cosmetic_log_only — operation succeeded, ERROR is on a downstream cosmetic side-effect
  {
    codename: "zigzag-vole",
    reason: "cosmetic_log_only",
    evidence: "agent successfully generates and posts its response before the reaction-swap is attempted; only the eyes→✅ emoji-swap fails silently",
  },
  {
    codename: "ochre-iguana",
    reason: "cosmetic_log_only",
    evidence: "set_thread_status is a cosmetic progress indicator shown inside Slack assistant threads; the failure has no effect on the actual agent response",
  },
  {
    codename: "ultra-moth",
    reason: "cosmetic_log_only",
    evidence: "agent execution is completely unaffected; only user-visible impact is that the 👀 acknowledgement reaction is not placed on a deleted Slack message",
  },
  {
    codename: "iridescent-dingo",
    reason: "cosmetic_log_only",
    evidence: "ERROR-level 'Future exception was never retrieved' noise emitted on every completed Stagehand browser session; the session itself completes",
  },
  {
    codename: "icy-okapi",
    reason: "cosmetic_log_only",
    evidence: "/v1/agent/browser-contexts/login endpoint completes successfully for the caller; outer try/except returns a warning only",
  },
  {
    codename: "crisp-echidna",
    reason: "cosmetic_log_only",
    evidence: "false ERROR log on Slack thread_not_found during paginated conversations.replies fetch; the surrounding Slack agent flow proceeds",
  },
  {
    codename: "keen-dolphin",
    reason: "cosmetic_log_only",
    evidence: "bug only affects telemetry noise (an ERROR log); reactions.remove fires no_reaction because earlier add_reaction silently failed",
  },
  {
    codename: "yeasty-ocelot",
    reason: "cosmetic_log_only",
    evidence: "last batch of Python log records dropped on every rolling deploy; otherwise no user-facing impact (deploy-time log loss only)",
  },

  // expected_third_party — third-party returns an error code that is part of its normal contract
  {
    codename: "keen-ibex",
    reason: "expected_third_party",
    evidence: "PriceLabs returns 404 for listings with no market comp data — expected/normal per the API contract",
  },
  {
    codename: "ochre-porcupine",
    reason: "expected_third_party",
    evidence: "Slack reactions.add returns benign already_reacted idempotency code, logged as ERROR by SlackClient._post() for all non-ok responses",
  },
  {
    codename: "snowy-hedgehog",
    reason: "expected_third_party",
    evidence: "Slack conversations.history returns not_in_channel after bot removed; deployed code logs error and silently returns []",
  },
  {
    codename: "luminous-caracal",
    reason: "expected_third_party",
    evidence: "Slack conversations.history returns channel_not_found when bot lacks access; logged but caller proceeds without history",
  },

  // lifecycle_signal — only fires during process lifecycle; in-flight work either completes or is retried
  {
    codename: "tender-lemur",
    reason: "lifecycle_signal",
    evidence: "spurious RuntimeError on every Fly.io rolling deploy from Python 3.13 shutdown_asyncgens(); all streaming responses complete before SIGTERM",
  },
  {
    codename: "uneven-armadillo",
    reason: "lifecycle_signal",
    evidence: "asyncio.shield(_finalize_trace) orphans inner Task on Fly.io SIGTERM during rolling deploy; the workflow itself has already responded",
  },
  {
    codename: "knotty-ray",
    reason: "lifecycle_signal",
    evidence: "SIGTERM signal handler raises SystemExit(0) mid-SSL-read on every Fly deploy; in-flight work is retried by orchestrators",
  },
  {
    codename: "cosmic-dingo",
    reason: "lifecycle_signal",
    evidence: "CancelledError during SIGTERM shutdown escapes _wrap_with_timeout job wrapper because asyncio.CancelledError is BaseException not Exception",
  },

  // self_telemetry — own telemetry/observability pipeline failing to export
  {
    codename: "rusty-marmot",
    reason: "self_telemetry",
    evidence: "PeriodicExportingMetricReader OTLP exports rate-limited (429) by Grafana Cloud; observability data only, application unaffected",
  },
  {
    codename: "hushed-robin",
    reason: "self_telemetry",
    evidence: "all three OTLP HTTP exporters (spans/metrics/logs) timing out against intake.superlog.sh; observability pipeline only",
  },

  // confusing_log_no_impact — ERROR log is misleading because the surrounding code recovers
  {
    codename: "neon-puma",
    reason: "confusing_log_no_impact",
    evidence: "_consume_stream's catch-all re-raises a bare asyncio.TimeoutError producing ' Attempt 1/3.' log; retry path runs and recovers normally",
  },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const dryRun = args.has("--dry-run") || !apply;

  if (!apply && !args.has("--dry-run")) {
    console.log("(no flag) defaulting to --dry-run; pass --apply to write");
  }

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  const codenames = CLASSIFICATIONS.map((c) => c.codename);
  const found = await db
    .select({
      id: schema.incidents.id,
      codename: schema.incidents.codename,
      status: schema.incidents.status,
      title: schema.incidents.title,
    })
    .from(schema.incidents)
    .where(
      and(
        eq(schema.incidents.projectId, TRELLIS_PROJECT_ID),
        inArray(schema.incidents.codename, codenames),
      ),
    );

  const byCodename = new Map(found.map((r) => [r.codename, r]));

  const missing = codenames.filter((cn) => !byCodename.has(cn));
  if (missing.length > 0) {
    console.warn(`missing in db: ${missing.join(", ")}`);
  }

  let toUpdate = 0;
  let alreadyNoise = 0;
  let alreadyResolved = 0;
  for (const c of CLASSIFICATIONS) {
    const row = byCodename.get(c.codename);
    if (!row) continue;
    if (row.status === "autoresolved_noise") {
      alreadyNoise++;
      continue;
    }
    if (row.status === "resolved") {
      // Don't clobber human-resolved status. Skip with a note.
      alreadyResolved++;
      console.log(`skip ${c.codename}: already resolved (not noise) — ${row.title.slice(0, 80)}`);
      continue;
    }
    toUpdate++;
    console.log(
      `${dryRun ? "[dry-run] " : ""}${c.codename} → autoresolved_noise (${c.reason})  ${row.title.slice(0, 80)}`,
    );
  }

  console.log(
    `\nplan: ${toUpdate} to update · ${alreadyNoise} already noise · ${alreadyResolved} already resolved · ${missing.length} not found`,
  );

  if (dryRun || toUpdate === 0) return;

  const now = new Date();
  for (const c of CLASSIFICATIONS) {
    const row = byCodename.get(c.codename);
    if (!row || row.status !== "open") continue;
    await db
      .update(schema.incidents)
      .set({
        status: "autoresolved_noise",
        noiseReason: c.reason,
        noiseResolvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.incidents.id, row.id));
  }
  console.log(`applied ${toUpdate} updates`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
