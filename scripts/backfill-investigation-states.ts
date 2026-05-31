// Backfills agentRun rows from the legacy state machine to the new one.
//
// Old → new mapping:
//   state="pr_opened"             → state="complete", result.pr.openStatus="opened" (url left null if absent)
//   state="ready_to_pr"           → state="complete", result.pr.openStatus="pending"
//   state="completed"             → state="complete"
//   state="stalled" / "failed" with failure_reason="agent_terminal_result"
//                                 → state="failed", failureReason="agent_no_findings"
//                                   (best-effort; agent can't be retroactively re-classified)
//   state="stalled"               → state="failed", failureReason from existing failure_reason if known,
//                                   else "runtime_budget_exhausted" as a default for legacy stalls
//   state="failed"                → state="failed" (failureReason normalized if it matches a known value)
//
// `result.state`, `result.confidenceGatePassed`, `result.selectedRepoFullName`,
// `result.branchName`, `result.baseBranch`, `result.patch`, `result.validationCommands`,
// `result.validationSummary`, `result.changedFiles` move under `result.pr` when they
// describe a PR; otherwise they're dropped.
//
// Run with:
//   pnpm tsx scripts/backfill-investigation-states.ts --dry-run
//   pnpm tsx scripts/backfill-investigation-states.ts --apply
//
// Always run --dry-run first against prod; review the transitions; then --apply.

import process from "node:process";
import { eq } from "drizzle-orm";

type LegacyResult = {
  state?: string;
  summary?: string;
  question?: string | null;
  confidenceGatePassed?: boolean;
  selectedRepoFullName?: string | null;
  branchName?: string | null;
  baseBranch?: string | null;
  patch?: string | null;
  validationCommands?: string[];
  validationSummary?: string | null;
  changedFiles?: string[];
  // tolerate already-migrated shape in case the script is re-run
  pr?: unknown;
  linearTicket?: unknown;
  failureReason?: string | null;
  rootCauseConfidence?: string | null;
};

const KNOWN_FAILURE_REASONS = new Set([
  "agent_no_findings",
  "patch_validation_failed",
  "pr_open_failed",
  "terminated_without_result",
  "runtime_budget_exhausted",
  "human_resume_budget_exhausted",
  "start_failed",
  "sync_failed",
  "resume_failed",
  "missing_session",
  "missing_session_for_resume",
  "github_repo_discovery_failed",
  "github_repo_token_failed",
  "unsupported_provider",
]);

function migrateResult(
  oldState: string,
  oldFailureReason: string | null,
  oldResult: LegacyResult | null,
): { state: string; failureReason: string | null; result: unknown } | null {
  // Already-migrated rows: skip.
  if (oldResult && oldResult.pr !== undefined && oldResult.linearTicket !== undefined) {
    return null;
  }

  const summary = oldResult?.summary ?? "";
  const rootCauseConfidence = oldResult?.rootCauseConfidence ?? null;
  const hasPatch = !!oldResult?.patch && !!oldResult?.selectedRepoFullName;

  // Build pr sub-object only when there's enough to describe one.
  const pr = hasPatch
    ? {
        selectedRepoFullName: oldResult!.selectedRepoFullName!,
        branchName: oldResult!.branchName ?? "",
        baseBranch: oldResult!.baseBranch ?? "main",
        patch: oldResult!.patch!,
        validationPassed: !!oldResult!.confidenceGatePassed,
        validationCommands: oldResult!.validationCommands ?? [],
        validationSummary: oldResult!.validationSummary ?? null,
        changedFiles: oldResult!.changedFiles ?? [],
        openStatus: oldState === "pr_opened" ? ("opened" as const) : ("pending" as const),
        url: null as string | null,
      }
    : null;

  if (oldState === "pr_opened" || oldState === "ready_to_pr" || oldState === "completed") {
    return {
      state: "complete",
      failureReason: null,
      result: {
        state: "complete",
        summary,
        pr,
        linearTicket: null,
        rootCauseConfidence,
      },
    };
  }

  if (oldState === "awaiting_human") {
    return {
      state: "awaiting_human",
      failureReason: null,
      result: {
        state: "awaiting_human",
        summary,
        question: oldResult?.question ?? null,
      },
    };
  }

  if (oldState === "stalled" || oldState === "failed") {
    // Special case: legacy `agent_terminal_result` lumps "agent gave up empty" with
    // "agent identified findings but couldn't PR" (e.g. org do-not-PR policy).
    // Inspect the summary to disambiguate, and lift any mentioned Linear ticket.
    if (oldFailureReason === "agent_terminal_result") {
      const ticketMatch = summary.match(
        /(?:Linear ticket|Filed Linear|Linear)\s+([A-Z]{2,8}-\d+)/i,
      );
      const hasFindings =
        !!ticketMatch ||
        /\broot cause\b/i.test(summary) ||
        /\bidentified\b/i.test(summary) ||
        /\bbug identified\b/i.test(summary);
      if (hasFindings) {
        return {
          state: "complete",
          failureReason: null,
          result: {
            state: "complete",
            summary,
            pr,
            linearTicket: ticketMatch
              ? { id: ticketMatch[1], url: null, createdByAgent: true }
              : null,
            rootCauseConfidence,
          },
        };
      }
      // Genuine no-findings legacy stall.
      const reason = "agent_no_findings";
      return {
        state: "failed",
        failureReason: reason,
        result: {
          state: "failed",
          summary,
          failureReason: reason,
          pr,
          linearTicket: null,
          rootCauseConfidence,
        },
      };
    }

    let reason: string;
    if (oldFailureReason && KNOWN_FAILURE_REASONS.has(oldFailureReason)) {
      reason = oldFailureReason;
    } else if (oldState === "stalled") {
      reason = "runtime_budget_exhausted";
    } else {
      reason = "sync_failed";
    }
    return {
      state: "failed",
      failureReason: reason,
      result: {
        state: "failed",
        summary,
        failureReason: reason,
        pr,
        linearTicket: null,
        rootCauseConfidence,
      },
    };
  }

  // Active states (queued, repo_discovery, running) — leave alone.
  return null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const apply = process.argv.includes("--apply");
  const dry = process.argv.includes("--dry-run") || !apply;

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  const rows = await db.query.agentRuns.findMany({});
  let migrated = 0;
  let skipped = 0;
  const transitions: Record<string, number> = {};

  for (const row of rows) {
    const update = migrateResult(
      row.state,
      row.failureReason ?? null,
      (row.result ?? null) as LegacyResult | null,
    );
    if (!update) {
      skipped += 1;
      continue;
    }
    const key = `${row.state} → ${update.state}${update.failureReason ? ` (${update.failureReason})` : ""}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    migrated += 1;

    if (!dry) {
      await db
        .update(schema.agentRuns)
        .set({
          state: update.state,
          failureReason: update.failureReason,
          // jsonb column — runtime shape matches packages/db/src/schema.ts AgentRunResult
          // (intentionally untyped here so this script doesn't import type-only symbols)
          result: update.result as never,
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, row.id));
    }
  }

  console.log(`${dry ? "DRY RUN" : "APPLIED"}: scanned ${rows.length}, migrating ${migrated}, leaving ${skipped} as-is.`);
  for (const [k, v] of Object.entries(transitions).sort()) {
    console.log(`  ${k}: ${v}`);
  }
  if (dry) console.log("\nRe-run with --apply to write the changes.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
