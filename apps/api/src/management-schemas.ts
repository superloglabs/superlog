import { z } from "zod";

// Slug rules: lowercase alphanumeric + dashes, max 40 chars.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const automergePolicySchema = z
  .enum(["never", "when_checks_pass", "immediately"])
  .describe(
    "Controls whether the agent's auto-opened fix PRs are merged. " +
      "'when_checks_pass' uses GitHub native auto-merge; 'immediately' calls the merge API right after PR open.",
  );

export const automergeMethodSchema = z
  .enum(["squash", "merge", "rebase"])
  .describe("Merge strategy used for auto-merge.");

const slugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(SLUG_RE, "slug must be lowercase alphanumeric + dashes, max 40 chars");

const nameSchema = z.string().min(1).max(120);

export const projectIdParamSchema = z.object({
  projectId: z.string().uuid(),
});

export const installationRowIdParamSchema = z.object({
  installationRowId: z.string().uuid(),
});

export const repoIdParamSchema = z.object({
  projectId: z.string().uuid(),
  repoId: z.string().regex(/^\d+$/, "repoId must be a positive integer"),
});

export const createProjectInputSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
  mint_ingest_key: z
    .boolean()
    .default(true)
    .describe("If true, mint an initial ingest key alongside the project."),
  automerge_fix_prs: automergePolicySchema.optional(),
  automerge_method: automergeMethodSchema.optional(),
});

export const updateProjectInputSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    automerge_fix_prs: automergePolicySchema.optional(),
    automerge_method: automergeMethodSchema.optional(),
  })
  .describe("Partial update. Only fields present in the body are written.");

export const mintApiKeyInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

export const installUrlInputSchema = z.object({
  return_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Where to bounce the user after install. Host must be in the org's allowed_return_url_hosts allowlist; must be http(s); must not embed credentials.",
    ),
});

export const grantRepoInputSchema = z.object({
  installation_id: z.string().uuid().describe("Install row UUID (from GET .../installations)."),
  repo_id: z.number().int().positive().describe("GitHub numeric repo ID."),
});

// ─── Telemetry read API ─────────────────────────────────────────────────────
// Generic GET endpoints for reading telemetry. Authed with the same
// sl_management_* keys as the rest of the management API. Anyone with a
// management key can use these; the dialtone uptime monitor happens to be
// one consumer.

const traceIdParamSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{1,64}$/, "trace_id must be 1–64 hex chars")
  .describe("Hex-encoded OTLP trace id.");

const isoOrRelativeTimeSchema = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "ISO 8601 timestamp (e.g. '2026-05-25T19:00:00Z') or a ClickHouse " +
      "relative expression (e.g. 'now() - INTERVAL 1 HOUR'). Defaults: from=1h ago, to=now.",
  );

export const traceByIdParamSchema = z.object({
  projectId: z.string().uuid(),
  traceId: traceIdParamSchema,
});

export const logsQuerySchema = z.object({
  trace_id: traceIdParamSchema.optional(),
  service: z.string().min(1).max(200).optional(),
  severity: z.string().min(1).max(40).optional(),
  search: z.string().min(1).max(500).optional(),
  from: isoOrRelativeTimeSchema.optional(),
  to: isoOrRelativeTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const metricsQuerySchema = z.object({
  name: z.string().min(1).max(200).describe("Metric name (e.g. 'http.server.duration')."),
  service: z.string().min(1).max(200).optional(),
  from: isoOrRelativeTimeSchema.optional(),
  to: isoOrRelativeTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// Schemas are deliberately open — these wrap existing internal helpers whose
// row shapes already feed the dashboard. Locking down the body in OpenAPI is
// future work; for now we document that the response is a JSON object.
export const telemetryReadResponseSchema = z
  .object({})
  .passthrough()
  .describe("ClickHouse rows. Shape mirrors what the dashboard /explore/* endpoints return.");

// ─── Response schemas ──────────────────────────────────────────────────────

export const projectSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    created_at: z.string().datetime().optional(),
    automerge_fix_prs: automergePolicySchema,
    automerge_method: automergeMethodSchema,
  })
  .describe("Project metadata.");

export const mintedApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string().describe("Stable prefix of the key (safe to display)."),
  plaintext: z.string().describe("Full key. Shown once — store immediately."),
});

export const createProjectResponseSchema = z.object({
  project: projectSchema,
  api_key: mintedApiKeySchema.nullable().describe(
    "Present when mint_ingest_key is true (default); null otherwise.",
  ),
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema),
});

export const projectResponseSchema = z.object({
  project: projectSchema,
});

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  last_used_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});

export const apiKeyListResponseSchema = z.object({
  api_keys: z.array(apiKeySchema),
});

export const mintApiKeyResponseSchema = z.object({
  api_key: mintedApiKeySchema,
});

export const installUrlResponseSchema = z.object({
  install_url: z.string().url(),
});

export const githubInstallationSchema = z.object({
  id: z.string().uuid(),
  installation_id: z.number().int().describe("GitHub's numeric install ID."),
  account_login: z.string().nullable(),
  account_type: z.string().nullable(),
  created_at: z.string().datetime(),
});

export const githubInstallationListResponseSchema = z.object({
  installations: z.array(githubInstallationSchema),
});

export const githubRepoSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
});

export const githubRepoListResponseSchema = z.object({
  repos: z.array(githubRepoSchema),
  truncated: z
    .boolean()
    .describe(
      "True if the install has more repos than the listing endpoint returns (cap is 1000).",
    ),
});

export const projectRepoGrantSchema = z.object({
  id: z.string().uuid(),
  installation_id: z.string().uuid(),
  repo_id: z.number().int(),
  repo_full_name: z.string(),
  created_at: z.string().datetime(),
});

export const grantRepoResponseSchema = z.object({
  grant: projectRepoGrantSchema,
});

export const grantListResponseSchema = z.object({
  grants: z.array(projectRepoGrantSchema),
});

export const okResponseSchema = z.object({
  ok: z.literal(true),
});

export const errorResponseSchema = z.object({
  error: z.string(),
});
