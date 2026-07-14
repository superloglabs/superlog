import { eq, sql } from "drizzle-orm";
import { db } from "./client.js";
import * as schema from "./schema.js";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const GRAPHQL_URL = "https://api.linear.app/graphql";
const REFRESH_GRACE_MS = 5 * 60 * 1000;

export type LinearTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export type LinearViewer = {
  id: string;
  email: string | null;
  organization: { id: string; name: string | null; urlKey: string | null };
};

export async function exchangeLinearCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<LinearTokenResponse> {
  const body = new URLSearchParams({
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`linear oauth exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as LinearTokenResponse;
}

export async function refreshLinearAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<LinearTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`linear oauth refresh failed: ${res.status} ${text}`);
  }
  return (await res.json()) as LinearTokenResponse;
}

export async function revokeLinearToken(token: string): Promise<void> {
  const body = new URLSearchParams({ token });
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }).catch(() => undefined);
}

export async function fetchLinearViewer(accessToken: string): Promise<LinearViewer> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: "query { viewer { id email organization { id name urlKey } } }",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`linear viewer query failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    data?: {
      viewer?: {
        id: string;
        email: string | null;
        organization: { id: string; name: string | null; urlKey: string | null };
      };
    };
    errors?: { message: string }[];
  };
  if (!json.data?.viewer) {
    throw new Error(`linear viewer query returned no data: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data.viewer;
}

export type LinearWebhook = { id: string; secret: string };

export async function createLinearWebhook(args: {
  accessToken: string;
  url: string;
  resourceTypes: string[];
  label?: string;
}): Promise<LinearWebhook> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({
      query:
        "mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id secret } } }",
      variables: {
        input: {
          url: args.url,
          resourceTypes: args.resourceTypes,
          allPublicTeams: true,
          label: args.label ?? "Superlog",
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`linear webhookCreate failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    data?: { webhookCreate?: { success?: boolean; webhook?: LinearWebhook } };
    errors?: { message: string }[];
  };
  const webhook = json.data?.webhookCreate?.webhook;
  if (!json.data?.webhookCreate?.success || !webhook?.id || !webhook.secret) {
    throw new Error(
      `linear webhookCreate returned no webhook: ${JSON.stringify(json.errors ?? json)}`,
    );
  }
  return webhook;
}

export async function deleteLinearWebhook(args: {
  accessToken: string;
  webhookId: string;
}): Promise<void> {
  await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({
      query: "mutation($id: String!) { webhookDelete(id: $id) { success } }",
      variables: { id: args.webhookId },
    }),
  }).catch(() => undefined);
}

async function linearGraphql<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`linear ${label} failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!json.data) {
    throw new Error(`linear ${label} returned no data: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

export type LinearTeam = { id: string; key: string; name: string };

export async function listLinearTeams(accessToken: string): Promise<LinearTeam[]> {
  const data = await linearGraphql<{ teams: { nodes: LinearTeam[] } }>(
    accessToken,
    "query { teams(first: 50) { nodes { id key name } } }",
    {},
    "teams query",
  );
  return data.teams.nodes;
}

export type LinearIssueRef = { id: string; identifier: string; url: string };

export async function searchLinearIssues(
  accessToken: string,
  term: string,
): Promise<LinearIssueRef[]> {
  const data = await linearGraphql<{ searchIssues: { nodes: LinearIssueRef[] } }>(
    accessToken,
    "query($term: String!) { searchIssues(term: $term, first: 5) { nodes { id identifier url } } }",
    { term },
    "searchIssues query",
  );
  return data.searchIssues.nodes;
}

export async function createLinearIssue(args: {
  accessToken: string;
  teamId: string;
  title: string;
  description: string;
}): Promise<LinearIssueRef> {
  const data = await linearGraphql<{
    issueCreate: { success?: boolean; issue?: LinearIssueRef };
  }>(
    args.accessToken,
    "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
    { input: { teamId: args.teamId, title: args.title, description: args.description } },
    "issueCreate",
  );
  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue?.id) {
    throw new Error(`linear issueCreate returned no issue: ${JSON.stringify(data)}`);
  }
  return issue;
}

export async function createLinearComment(args: {
  accessToken: string;
  issueId: string;
  body: string;
}): Promise<void> {
  const data = await linearGraphql<{ commentCreate: { success?: boolean } }>(
    args.accessToken,
    "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
    { input: { issueId: args.issueId, body: args.body } },
    "commentCreate",
  );
  if (!data.commentCreate.success) {
    throw new Error(`linear commentCreate did not succeed: ${JSON.stringify(data)}`);
  }
}

export type LinearAgentActivityType = "thought" | "response" | "elicitation" | "error";

export async function createLinearAgentActivity(args: {
  accessToken: string;
  agentSessionId: string;
  type: LinearAgentActivityType;
  body: string;
  ephemeral?: boolean;
}): Promise<{ id: string }> {
  const data = await linearGraphql<{
    agentActivityCreate: {
      success?: boolean;
      agentActivity?: { id?: string };
    };
  }>(
    args.accessToken,
    "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }",
    {
      input: {
        agentSessionId: args.agentSessionId,
        content: { type: args.type, body: args.body },
        ...(args.ephemeral === undefined ? {} : { ephemeral: args.ephemeral }),
      },
    },
    "agentActivityCreate",
  );
  const id = data.agentActivityCreate.agentActivity?.id;
  if (!data.agentActivityCreate.success || !id) {
    throw new Error(`linear agentActivityCreate did not succeed: ${JSON.stringify(data)}`);
  }
  return { id };
}

export async function updateLinearAgentSession(args: {
  accessToken: string;
  agentSessionId: string;
  externalUrls: Array<{ label: string; url: string }>;
}): Promise<void> {
  const data = await linearGraphql<{ agentSessionUpdate: { success?: boolean } }>(
    args.accessToken,
    "mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
    { id: args.agentSessionId, input: { externalUrls: args.externalUrls } },
    "agentSessionUpdate",
  );
  if (!data.agentSessionUpdate.success) {
    throw new Error(`linear agentSessionUpdate did not succeed: ${JSON.stringify(data)}`);
  }
}

/**
 * Returns a usable access token for the installation, refreshing in place if it's
 * within REFRESH_GRACE_MS of expiry. Persists rotated refresh tokens.
 */
export async function ensureFreshLinearToken(args: {
  installationId: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt: Date | null; rotated: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${args.installationId}, 0))`,
    );

    const row = await tx.query.linearInstallations.findFirst({
      where: eq(schema.linearInstallations.id, args.installationId),
    });
    if (!row) throw new Error(`linear installation ${args.installationId} not found`);
    if (row.revokedAt) throw new Error("linear installation is revoked");
    if (row.reauthRequiredAt) throw new Error("linear installation requires reauthorization");

    const expiresMs = row.accessExpiresAt ? row.accessExpiresAt.getTime() : 0;
    const needsRefresh = !expiresMs || Date.now() + REFRESH_GRACE_MS >= expiresMs;
    if (!needsRefresh) {
      return { accessToken: row.accessToken, expiresAt: row.accessExpiresAt, rotated: false };
    }
    if (!row.refreshToken) {
      return { accessToken: row.accessToken, expiresAt: row.accessExpiresAt, rotated: false };
    }

    const fresh = await refreshLinearAccessToken({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      refreshToken: row.refreshToken,
    });
    const newExpiresAt =
      typeof fresh.expires_in === "number" ? new Date(Date.now() + fresh.expires_in * 1000) : null;
    await tx
      .update(schema.linearInstallations)
      .set({
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token ?? row.refreshToken,
        accessExpiresAt: newExpiresAt,
        scope: fresh.scope ?? row.scope,
        updatedAt: new Date(),
      })
      .where(eq(schema.linearInstallations.id, args.installationId));
    return { accessToken: fresh.access_token, expiresAt: newExpiresAt, rotated: true };
  });
}

export async function markLinearInstallationNeedsReauth(
  installationId: string,
  reason: string,
): Promise<void> {
  await db
    .update(schema.linearInstallations)
    .set({
      reauthRequiredAt: new Date(),
      reauthReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(schema.linearInstallations.id, installationId));
}
