// Duplicate-patch gate for agent-authored PRs.
//
// A human closing a bot PR unmerged is a strong, durable signal — but a
// closed PR leaves no trace in the repo checkout, so a later agent session
// investigating the same incident can produce a byte-identical patch and
// resubmit it. Each opened agent PR records a hash of its normalized patch
// body (agent_pull_requests.patch_hash); before opening a new PR the worker
// looks for a closed-unmerged twin on the same repo and refuses to reopen it.
// Merged PRs don't block: a recurrence after a merged fix is fresh signal.

import { createHash } from "node:crypto";
import { type DB, db, schema } from "@superlog/db";
import { and, desc, eq } from "drizzle-orm";
import { normalizeAgentPatch } from "../github-app.js";

export function hashAgentPatch(patch: string): string {
  return createHash("sha256").update(normalizeAgentPatch(patch)).digest("hex");
}

export type RejectedDuplicatePatch = { prNumber: number; url: string };

export async function findRejectedDuplicatePatch(opts: {
  database?: DB;
  repoFullName: string;
  patchHash: string;
}): Promise<RejectedDuplicatePatch | null> {
  const database = opts.database ?? db;
  const rows = await database
    .select({
      prNumber: schema.agentPullRequests.prNumber,
      url: schema.agentPullRequests.url,
    })
    .from(schema.agentPullRequests)
    .where(
      and(
        eq(schema.agentPullRequests.repoFullName, opts.repoFullName),
        eq(schema.agentPullRequests.patchHash, opts.patchHash),
        eq(schema.agentPullRequests.state, "closed"),
      ),
    )
    .orderBy(desc(schema.agentPullRequests.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
