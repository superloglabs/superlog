import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";

const MAX_CLAUSES_PER_BUCKET = 20;
const CLAUSE_KEY_MAX_LEN = 200;
const CLAUSE_VALUE_MAX_LEN = 400;

export const ISSUE_FILTER_BUCKETS = [
  "includeLogs",
  "includeSpans",
  "excludeLogs",
  "excludeSpans",
] as const satisfies readonly (keyof schema.IssueFilterConfig)[];

/**
 * Normalize an arbitrary value into a clean clause list: drop non-objects and
 * clauses missing key/value, trim, cap key/value length, dedupe
 * case-insensitively by key (value compared verbatim), and cap the list size.
 * Shared by the REST automation handler and the MCP issue-filter tools so both
 * surfaces apply identical rules.
 */
export function sanitizeClauseList(input: unknown): schema.IssueFilterClause[] {
  if (!Array.isArray(input)) return [];
  const out: schema.IssueFilterClause[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const key =
      typeof (item as { key?: unknown }).key === "string"
        ? (item as { key: string }).key.trim()
        : "";
    const value =
      typeof (item as { value?: unknown }).value === "string"
        ? (item as { value: string }).value.trim()
        : "";
    if (!key || !value) continue;
    const dedupe = `${key.toLowerCase()}=${value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      key: key.slice(0, CLAUSE_KEY_MAX_LEN),
      value: value.slice(0, CLAUSE_VALUE_MAX_LEN),
    });
    if (out.length >= MAX_CLAUSES_PER_BUCKET) break;
  }
  return out;
}

/**
 * Sanitize a whole config. Any bucket that isn't a usable array falls back to
 * the corresponding bucket in `fallback` (so a malformed partial doesn't wipe
 * existing rules).
 */
export function sanitizeIssueFilterConfig(
  input: unknown,
  fallback: schema.IssueFilterConfig,
): schema.IssueFilterConfig {
  if (!input || typeof input !== "object") return fallback;
  const o = input as Partial<Record<keyof schema.IssueFilterConfig, unknown>>;
  return {
    includeLogs: sanitizeClauseList(o.includeLogs),
    includeSpans: sanitizeClauseList(o.includeSpans),
    excludeLogs: sanitizeClauseList(o.excludeLogs),
    excludeSpans: sanitizeClauseList(o.excludeSpans),
  };
}

/**
 * Per-bucket patch: only buckets present in `patch` are replaced (after
 * sanitizing); buckets the caller omits keep their current value. Lets the MCP
 * `update_issue_filter` tool tweak one bucket without resending the rest.
 */
export function mergeIssueFilterConfig(
  current: schema.IssueFilterConfig,
  patch: Partial<Record<keyof schema.IssueFilterConfig, unknown>>,
): schema.IssueFilterConfig {
  const next: schema.IssueFilterConfig = { ...current };
  for (const bucket of ISSUE_FILTER_BUCKETS) {
    if (patch[bucket] !== undefined) next[bucket] = sanitizeClauseList(patch[bucket]);
  }
  return next;
}

export async function getIssueFilterConfig(projectId: string): Promise<schema.IssueFilterConfig> {
  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
    columns: { issueFilterConfig: true },
  });
  return row?.issueFilterConfig ?? schema.EMPTY_ISSUE_FILTER_CONFIG;
}

/**
 * Persist a fully-formed config, upserting the automation row if absent. The
 * caller is responsible for sanitizing/merging first.
 */
export async function setIssueFilterConfig(
  projectId: string,
  config: schema.IssueFilterConfig,
): Promise<schema.IssueFilterConfig> {
  await db
    .insert(schema.projectAutomationSettings)
    .values({ projectId, issueFilterConfig: config })
    .onConflictDoUpdate({
      target: schema.projectAutomationSettings.projectId,
      set: { issueFilterConfig: config, updatedAt: new Date() },
    });
  return config;
}
