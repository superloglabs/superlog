// Pure domain for the weekly Slack bug-fix digest: types, message
// builders, picks parser, severity icon. No I/O — every function takes
// plain data in and returns plain data out.

export const TOP_N = 3;

// Slack section blocks have a 3000-char text limit; with severity prefix,
// project/service context, codename, and the PR link, the rationale is the
// only field that scales with the LLM's verbosity. Cap it to the same length
// the trivial-picks fallback already uses so an over-eager model can't make
// the digest message rejected outright.
export const MAX_RATIONALE_LENGTH = 240;

export type DigestCandidate = {
  agentRunId: string;
  incidentId: string;
  incidentCodename: string;
  incidentTitle: string;
  projectName: string;
  service: string | null;
  severity: string | null;
  completedAt: Date;
  summary: string;
  rootCause: string | null;
  estimatedImpact: string | null;
  pr: {
    id: string;
    repoFullName: string;
    number: number;
    title: string | null;
    url: string;
    branch: string;
    baseBranch: string;
    openedAt: Date;
  };
};

export type DigestPick = {
  agentRunId: string;
  rationale: string;
};

export type RankedDigestPick = {
  pick: DigestPick;
  candidate: DigestCandidate;
};

export const DIGEST_SYSTEM_PROMPT = [
  "You rank pending bug-fix pull requests for a weekly Slack digest.",
  "You will receive a list of completed agent_runs whose proposed fix PR is still open (not merged).",
  `Pick the ${TOP_N} most important to merge this week. Importance signals, in rough priority order:`,
  "1. Severity (SEV-1 > SEV-2 > SEV-3 > unset)",
  "2. Estimated user/business impact described in the agent run",
  "3. Strength of root-cause evidence (high-confidence fixes are safer to merge)",
  "4. Age of the open PR (older = more drag on the team)",
  "Skip anything that looks like a test, doc, or trivial cleanup unless nothing else is available.",
  "Respond with a single JSON object only, no prose, no markdown fences:",
  '{"picks":[{"agentRunId":"<id>","rationale":"<one sentence why this should merge first>"}, ...]}',
  `Order picks from most to least important. Return at most ${TOP_N}. If fewer candidates exist, return fewer picks.`,
].join("\n");

export function buildRankingUserMessage(candidates: DigestCandidate[]): string {
  return [
    "Open bug-fix PRs to rank:",
    "",
    JSON.stringify(
      candidates.map((c) => ({
        agentRunId: c.agentRunId,
        incident: { codename: c.incidentCodename, title: c.incidentTitle },
        project: c.projectName,
        service: c.service,
        severity: c.severity,
        completedAt: c.completedAt.toISOString(),
        summary: c.summary,
        rootCause: c.rootCause,
        estimatedImpact: c.estimatedImpact,
        pr: {
          repo: c.pr.repoFullName,
          number: c.pr.number,
          title: c.pr.title,
          openedAt: c.pr.openedAt.toISOString(),
        },
      })),
      null,
      2,
    ),
  ].join("\n");
}

export function parsePicks(raw: string, validIds: ReadonlySet<string>): DigestPick[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const picks = (parsed as { picks?: unknown }).picks;
  if (!Array.isArray(picks)) return [];
  const out: DigestPick[] = [];
  const seen = new Set<string>();
  for (const item of picks) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const agentRunId = typeof obj.agentRunId === "string" ? obj.agentRunId : "";
    const rawRationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
    if (!agentRunId || !rawRationale) continue;
    if (!validIds.has(agentRunId)) continue;
    if (seen.has(agentRunId)) continue;
    seen.add(agentRunId);
    out.push({ agentRunId, rationale: rawRationale.slice(0, MAX_RATIONALE_LENGTH) });
    if (out.length >= TOP_N) break;
  }
  return out;
}

export function severityEmoji(severity: string | null): string {
  switch (severity) {
    case "SEV-1":
      return ":rotating_light:";
    case "SEV-2":
      return ":warning:";
    case "SEV-3":
      return ":small_orange_diamond:";
    default:
      return ":hammer_and_wrench:";
  }
}

export function buildDigestBlocks(picks: RankedDigestPick[]): { text: string; blocks: unknown[] } {
  const headerLine = `:sparkles: *Top ${picks.length} fixes to merge this week*`;
  const subline =
    picks.length === 1
      ? "_One pending bug-fix PR is ready for review._"
      : `_${picks.length} pending bug-fix PRs are ready for review, ranked by impact._`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `${headerLine}\n${subline}` } },
    { type: "divider" },
  ];
  picks.forEach(({ pick, candidate }, idx) => {
    const severity = candidate.severity ? `*${candidate.severity}* · ` : "";
    const lines = [
      `*${idx + 1}.* ${severityEmoji(candidate.severity)} *<${candidate.pr.url}|${candidate.pr.title ?? candidate.incidentTitle}>*`,
      `${severity}\`${candidate.projectName}\`${candidate.service ? ` · \`${candidate.service}\`` : ""} · _${candidate.incidentCodename}_`,
      `> ${pick.rationale}`,
      `<${candidate.pr.url}|${candidate.pr.repoFullName}#${candidate.pr.number}>`,
    ];
    blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } });
  });
  const fallbackText = `Top ${picks.length} fixes to merge: ${picks
    .map(({ candidate }) => `${candidate.incidentCodename} (${candidate.pr.url})`)
    .join(", ")}`;
  return { text: fallbackText, blocks };
}

// Compose the LLM picks with the original candidates and drop picks whose
// agentRunId wasn't a valid candidate (the parser guards this, but a
// caller may bypass it). Cap at TOP_N.
export function attachCandidatesToPicks(
  picks: DigestPick[],
  candidates: ReadonlyArray<DigestCandidate>,
): RankedDigestPick[] {
  const byId = new Map(candidates.map((c) => [c.agentRunId, c]));
  return picks
    .map((pick) => ({ pick, candidate: byId.get(pick.agentRunId) }))
    .filter((row): row is RankedDigestPick => !!row.candidate)
    .slice(0, TOP_N);
}

// Trivial rationale fallback: when the candidate list is short enough to
// skip the LLM, surface each candidate as its own pick with a truncated
// summary so the digest still posts.
export function trivialPicks(candidates: DigestCandidate[]): DigestPick[] {
  return candidates.map((c) => ({
    agentRunId: c.agentRunId,
    rationale: c.summary.slice(0, MAX_RATIONALE_LENGTH),
  }));
}
