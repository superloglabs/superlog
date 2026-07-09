import { createHash } from "node:crypto";
import {
  db,
  decryptIntegrationSecret,
  schema,
  type IntegrationDefinition,
  type IntegrationOperation,
  type OrgIntegration,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  buildNotionResolvedIntegration,
  loadActiveNotionInstallation,
} from "./notion-integration.js";

const log = logger.child({ scope: "integrations" });

export const REVYL_INTEGRATION: IntegrationDefinition = {
  slug: "revyl",
  name: "Revyl",
  description:
    "Trigger and inspect Revyl test runs and workflows; author new regression tests from YAML.",
  base_url: "https://backend.revyl.ai",
  required_secrets: [
    {
      name: "REVYL_API_KEY",
      description: "Revyl bearer token (Settings → API Keys in Revyl).",
    },
  ],
  default_headers: {
    Authorization: "Bearer {{secrets.REVYL_API_KEY}}",
    "X-Revyl-Client": "superlog-agent run",
    "Content-Type": "application/json",
  },
  operations: [
    {
      name: "revyl_run_test",
      description:
        "Trigger an async run of an existing Revyl test by id. Returns a task_id; poll with revyl_get_test_run.",
      method: "POST",
      path: "/api/v1/execution/api/execute_test_id_async",
      input_schema: {
        type: "object",
        required: ["test_id"],
        additionalProperties: false,
        properties: {
          test_id: { type: "string", format: "uuid" },
          variable_overrides: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Runtime variable overrides; highest priority. Use to parameterize a reproduction.",
          },
          retries: { type: "integer", minimum: 0, maximum: 3 },
        },
      },
      body_template: {
        test_id: "{{input.test_id}}",
        variable_overrides: "{{input.variable_overrides?}}",
        retries: "{{input.retries?}}",
        source: "api",
      },
      response_filter: ["status", "message", "id", "task_id"],
    },
    {
      name: "revyl_get_test_run",
      description: "Retrieve current status and result of a previously triggered test run.",
      method: "GET",
      path: "/api/v1/tests/get_test_execution_task",
      docs_only: true,
      input_schema: {
        type: "object",
        required: ["task_id"],
        additionalProperties: false,
        properties: { task_id: { type: "string" } },
      },
      query_template: { task_id: "{{input.task_id}}" },
    },
    {
      name: "revyl_cancel_test_run",
      description: "Cancel a running test execution.",
      method: "POST",
      path: "/api/v1/execution/tests/status/cancel/{task_id}",
      input_schema: {
        type: "object",
        required: ["task_id"],
        additionalProperties: false,
        properties: { task_id: { type: "string" } },
      },
      path_template: { task_id: "{{input.task_id}}" },
    },
    {
      name: "revyl_run_workflow",
      description: "Trigger an async run of a Revyl workflow (a sequence of tests).",
      method: "POST",
      path: "/api/v1/execution/api/execute_workflow_id_async",
      input_schema: {
        type: "object",
        required: ["workflow_id"],
        additionalProperties: false,
        properties: { workflow_id: { type: "string", format: "uuid" } },
      },
      body_template: { workflow_id: "{{input.workflow_id}}" },
      response_filter: ["status", "message", "id", "task_id"],
    },
    {
      name: "revyl_get_workflow_run",
      description: "Retrieve current status of a previously triggered workflow run.",
      method: "GET",
      path: "/api/v1/workflows/status/status/{task_id}",
      docs_only: true,
      input_schema: {
        type: "object",
        required: ["task_id"],
        additionalProperties: false,
        properties: { task_id: { type: "string" } },
      },
      path_template: { task_id: "{{input.task_id}}" },
    },
    {
      name: "revyl_workflow_history",
      description:
        "List recent runs of a workflow. Use to correlate against an incident time window.",
      method: "GET",
      path: "/api/v1/workflows/history/{workflow_id}",
      docs_only: true,
      input_schema: {
        type: "object",
        required: ["workflow_id"],
        additionalProperties: false,
        properties: {
          workflow_id: { type: "string", format: "uuid" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      },
      path_template: { workflow_id: "{{input.workflow_id}}" },
      query_template: { limit: "{{input.limit?}}" },
    },
    {
      name: "revyl_validate_yaml",
      description:
        "Pre-flight a YAML test definition before creating it. Returns is_valid + per-line messages.",
      method: "POST",
      path: "/api/v1/tests/yaml/validate-yaml",
      input_schema: {
        type: "object",
        required: ["yaml_content"],
        additionalProperties: false,
        properties: {
          yaml_content: { type: "string", minLength: 1 },
          platform: { type: "string" },
        },
      },
      body_template: {
        yaml_content: "{{input.yaml_content}}",
        validation_type: "full_test",
        platform: "{{input.platform?}}",
      },
    },
    {
      name: "revyl_create_test_from_yaml",
      description:
        "Create a new Revyl test from a YAML definition. Use AFTER revyl_validate_yaml passes. The worker auto-tags the test with superlog_incident_id and superlog_session_id.",
      method: "POST",
      path: "/api/v1/tests/yaml/from-yaml",
      rate_limit_per_session: 3,
      input_schema: {
        type: "object",
        required: ["yaml_content"],
        additionalProperties: false,
        properties: {
          yaml_content: { type: "string", minLength: 1 },
        },
      },
      body_template: {
        yaml_content: "{{input.yaml_content}}",
        metadata_overrides: {
          superlog_incident_id: "{{context.incident_id}}",
          superlog_session_id: "{{context.session_id}}",
        },
      },
      response_filter: ["success", "test_id", "blocks_count", "errors", "error"],
    },
  ],
};

export const INTEGRATIONS_BY_SLUG: Record<string, IntegrationDefinition> = {
  [REVYL_INTEGRATION.slug]: REVYL_INTEGRATION,
};

export type ResolvedIntegration = {
  row: OrgIntegration;
  definition: IntegrationDefinition;
  secrets: Record<string, string>;
};

export async function loadEnabledIntegrationsForOrg(
  orgId: string,
): Promise<ResolvedIntegration[]> {
  const rows = await db
    .select()
    .from(schema.orgIntegrations)
    .where(and(eq(schema.orgIntegrations.orgId, orgId), eq(schema.orgIntegrations.enabled, true)));

  const resolved: ResolvedIntegration[] = [];
  for (const row of rows) {
    const definition = INTEGRATIONS_BY_SLUG[row.slug];
    if (!definition) {
      log.warn({ orgId, slug: row.slug }, "enabled integration has unknown slug; skipping");
      continue;
    }
    const secretRows = await db
      .select()
      .from(schema.orgIntegrationSecrets)
      .where(eq(schema.orgIntegrationSecrets.orgIntegrationId, row.id));
    const secrets: Record<string, string> = {};
    for (const s of secretRows) {
      try {
        secrets[s.secretName] = decryptIntegrationSecret({
          ciphertext: s.ciphertext,
          nonce: s.nonce,
          keyVersion: s.keyVersion,
        });
      } catch (err) {
        log.error(
          { err, orgIntegrationId: row.id, secretName: s.secretName },
          "integration secret decryption failed; skipping integration",
        );
        continue;
      }
    }
    const missing = definition.required_secrets
      .map((spec) => spec.name)
      .filter((name) => !(name in secrets));
    if (missing.length > 0) {
      log.warn(
        { orgIntegrationId: row.id, slug: row.slug, missing },
        "integration missing required secrets; skipping",
      );
      continue;
    }
    resolved.push({ row, definition, secrets });
  }
  return resolved;
}

/**
 * All integrations an investigation run should get for a given org+project:
 * the org-scoped generic "Tools" integrations plus, if the run's project has a
 * connected Notion workspace, the Notion tools synthesized from its OAuth grant.
 */
export async function loadRunIntegrations(args: {
  orgId: string;
  projectId: string;
}): Promise<ResolvedIntegration[]> {
  const [generic, notionInstall] = await Promise.all([
    loadEnabledIntegrationsForOrg(args.orgId),
    loadActiveNotionInstallation(args.projectId),
  ]);
  if (!notionInstall) return generic;
  return [...generic, buildNotionResolvedIntegration(notionInstall, args.orgId)];
}

export function hashIntegrationSet(integrations: ResolvedIntegration[]): string {
  if (integrations.length === 0) return "none";
  const fingerprint = integrations
    .map((i) =>
      i.definition.operations.map((op) => `${op.name}:${op.method}:${op.path}`).sort().join("|"),
    )
    .sort()
    .join("||");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

export function buildCustomToolParams(integrations: ResolvedIntegration[]): Array<{
  type: "custom";
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}> {
  const tools: ReturnType<typeof buildCustomToolParams> = [];
  for (const integration of integrations) {
    for (const op of integration.definition.operations) {
      tools.push({
        type: "custom",
        name: op.name,
        description: truncateDescription(op.description),
        input_schema: sanitizeCustomToolInputSchema(op.input_schema),
      });
    }
  }
  return tools;
}

const TOP_LEVEL_ALLOWED = new Set(["type", "properties", "required", "description"]);
const NESTED_ALLOWED = new Set([
  "type",
  "description",
  "enum",
  "items",
  "properties",
  "required",
]);

function sanitizeCustomToolInputSchema(schema: unknown): {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
} {
  if (!isPlainObject(schema)) return { type: "object" };
  const out: Record<string, unknown> = { type: "object" };
  for (const [k, v] of Object.entries(schema)) {
    if (!TOP_LEVEL_ALLOWED.has(k)) continue;
    if (k === "properties" && isPlainObject(v)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(v)) {
        props[propName] = sanitizeNested(propSchema);
      }
      out.properties = props;
    } else {
      out[k] = v;
    }
  }
  return out as { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

function sanitizeNested(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!NESTED_ALLOWED.has(k)) continue;
    if (k === "properties" && isPlainObject(v)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(v)) {
        props[propName] = sanitizeNested(propSchema);
      }
      out.properties = props;
    } else if (k === "items") {
      out.items = sanitizeNested(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncateDescription(s: string): string {
  return s.length <= 1024 ? s : s.slice(0, 1021) + "...";
}

type ContextVars = { incident_id: string; session_id: string };

export async function executeIntegrationOperation(
  integration: ResolvedIntegration,
  op: IntegrationOperation,
  input: Record<string, unknown>,
  context: ContextVars,
): Promise<unknown> {
  const sub = (s: string) => substitute(s, { input, secrets: integration.secrets, context });
  const url = new URL(
    integration.definition.base_url + renderPath(op.path, op.path_template, input),
  );
  if (op.query_template) {
    for (const [k, v] of Object.entries(op.query_template)) {
      const rendered = sub(v);
      if (rendered !== "" && rendered !== "undefined") url.searchParams.set(k, rendered);
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(integration.definition.default_headers)) {
    headers[k] = sub(v);
  }
  let body: string | undefined;
  if (op.body_template && op.method !== "GET") {
    body = JSON.stringify(
      renderTemplate(op.body_template, { input, secrets: integration.secrets, context }),
    );
  }
  const res = await fetch(url.toString(), { method: op.method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${op.method} ${op.path} failed: ${res.status} ${truncate(text, 500)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function renderPath(
  path: string,
  template: Record<string, string> | undefined,
  input: Record<string, unknown>,
): string {
  if (!template) return path;
  let out = path;
  for (const [k, v] of Object.entries(template)) {
    const rendered = substitute(v, {
      input,
      secrets: {},
      context: { incident_id: "", session_id: "" },
    });
    out = out.replace(`{${k}}`, encodeURIComponent(rendered));
  }
  return out;
}

function renderTemplate(
  value: unknown,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: ContextVars },
): unknown {
  if (typeof value === "string") {
    const optional = value.endsWith("?}}");
    const ref = value.match(/^\{\{([^}]+?)\??\}\}$/);
    if (ref) {
      const path = ref[1] ?? "";
      const resolved = resolvePath(path, vars);
      if (optional && (resolved === undefined || resolved === null)) return undefined;
      return resolved ?? null;
    }
    return substitute(value, vars);
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rendered = renderTemplate(v, vars);
      if (rendered !== undefined) out[k] = rendered;
    }
    return out;
  }
  return value;
}

function resolvePath(
  path: string,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: ContextVars },
): unknown {
  const parts = path.split(".");
  let cur: unknown = vars as unknown as Record<string, unknown>;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function substitute(
  s: string,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: ContextVars },
): string {
  return s.replace(/\{\{([^}]+?)\??\}\}/g, (_, path: string) => {
    const v = resolvePath(path, vars);
    return v == null ? "" : String(v);
  });
}

export function validateIntegrationInput(
  input: unknown,
  schema: Record<string, unknown>,
): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "input must be an object";
  }
  const required = (schema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (!(key in input)) return `missing required field: ${key}`;
  }
  const properties = schema.properties as Record<string, { type?: string }> | undefined;
  if (properties) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const propSchema = properties[key];
      if (!propSchema) {
        if (schema.additionalProperties === false) return `unknown field: ${key}`;
        continue;
      }
      if (propSchema.type && !matchesType(value, propSchema.type)) {
        return `field ${key} expected ${propSchema.type}, got ${typeof value}`;
      }
    }
  }
  return null;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

export function filterIntegrationResponse(value: unknown, allowed: string[] | undefined): unknown {
  if (!allowed || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in (value as Record<string, unknown>)) {
      out[key] = (value as Record<string, unknown>)[key];
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}
