// Notion is a dedicated OAuth connector (own table + connect flow), but its
// agent-facing tools ride the same IntegrationDefinition dispatch machinery as
// the generic "Tools" integrations. We synthesize a ResolvedIntegration from a
// project's notion_installations row and hand it to the same tool builder /
// executor — so no bespoke tool handlers, just a declarative op list fed a
// per-project OAuth token instead of an org-secret.
import { type IntegrationDefinition, type NotionInstallation, db, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedIntegration } from "./integrations.js";

export const NOTION_INTEGRATION: IntegrationDefinition = {
  slug: "notion",
  name: "Notion",
  description:
    "Read Notion pages and databases the connected workspace has shared with Superlog — runbooks, architecture notes, on-call docs.",
  base_url: "https://api.notion.com",
  required_secrets: [
    {
      name: "NOTION_ACCESS_TOKEN",
      description: "Bot access token from the Notion OAuth grant.",
    },
  ],
  default_headers: {
    Authorization: "Bearer {{secrets.NOTION_ACCESS_TOKEN}}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
  operations: [
    {
      name: "notion_search",
      description:
        "Search the connected Notion workspace by title for pages and databases shared with the integration. Omit query to list everything shared. Returns page/database ids and titles; follow up with notion_get_page_content to read a page.",
      method: "POST",
      path: "/v1/search",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Title text to match. Omit to list all shared pages/databases.",
          },
          page_size: { type: "integer", minimum: 1, maximum: 50 },
          start_cursor: {
            type: "string",
            description: "Pagination cursor from a previous response's next_cursor.",
          },
        },
      },
      body_template: {
        query: "{{input.query?}}",
        page_size: "{{input.page_size?}}",
        start_cursor: "{{input.start_cursor?}}",
      },
      response_filter: ["results", "next_cursor", "has_more"],
    },
    {
      name: "notion_get_page",
      description:
        "Retrieve a Notion page's metadata and properties (including its title) by page id. For the page body use notion_get_page_content.",
      method: "GET",
      path: "/v1/pages/{page_id}",
      path_template: { page_id: "{{input.page_id}}" },
      input_schema: {
        type: "object",
        required: ["page_id"],
        additionalProperties: false,
        properties: { page_id: { type: "string" } },
      },
    },
    {
      name: "notion_get_page_content",
      description:
        "Read the child blocks (the actual text content) of a Notion page or block by id. Paginate with start_cursor when has_more is true.",
      method: "GET",
      path: "/v1/blocks/{block_id}/children",
      path_template: { block_id: "{{input.block_id}}" },
      query_template: {
        page_size: "{{input.page_size?}}",
        start_cursor: "{{input.start_cursor?}}",
      },
      input_schema: {
        type: "object",
        required: ["block_id"],
        additionalProperties: false,
        properties: {
          block_id: {
            type: "string",
            description: "A page id or block id to read children of.",
          },
          page_size: { type: "integer", minimum: 1, maximum: 100 },
          start_cursor: { type: "string" },
        },
      },
      response_filter: ["results", "next_cursor", "has_more"],
    },
    {
      name: "notion_query_database",
      description:
        "List the entries (rows) of a Notion database by database id. Paginate with start_cursor when has_more is true.",
      method: "POST",
      path: "/v1/databases/{database_id}/query",
      path_template: { database_id: "{{input.database_id}}" },
      input_schema: {
        type: "object",
        required: ["database_id"],
        additionalProperties: false,
        properties: {
          database_id: { type: "string" },
          page_size: { type: "integer", minimum: 1, maximum: 50 },
          start_cursor: { type: "string" },
        },
      },
      body_template: {
        page_size: "{{input.page_size?}}",
        start_cursor: "{{input.start_cursor?}}",
      },
      response_filter: ["results", "next_cursor", "has_more"],
    },
  ],
};

export function buildNotionResolvedIntegration(
  installation: NotionInstallation,
  orgId: string,
): ResolvedIntegration {
  return {
    // `row` is unused by the dispatch pipeline (it keys off definition +
    // secrets); we fill a faithful-enough OrgIntegration shape for the type.
    row: {
      id: installation.id,
      orgId,
      slug: NOTION_INTEGRATION.slug,
      enabled: true,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
    },
    definition: NOTION_INTEGRATION,
    secrets: { NOTION_ACCESS_TOKEN: installation.accessToken },
  };
}

export async function loadActiveNotionInstallation(
  projectId: string,
): Promise<NotionInstallation | null> {
  const row = await db.query.notionInstallations.findFirst({
    where: and(
      eq(schema.notionInstallations.projectId, projectId),
      isNull(schema.notionInstallations.revokedAt),
      isNull(schema.notionInstallations.reauthRequiredAt),
    ),
  });
  return row ?? null;
}
