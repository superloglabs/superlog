// Notion OAuth token exchange + revocation. The connector stores a bot-scoped
// access token per workspace grant (Linear-style, per project); the agent's
// Notion tools read through that token via the integration dispatch machinery.
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
// Notion rejects /v1/* requests without a version header; send it on the OAuth
// calls too, matching the agent-facing operations' default headers.
const NOTION_VERSION = "2022-06-28";

export type NotionOwnerUser = {
  object?: string;
  id?: string;
  name?: string | null;
  avatar_url?: string | null;
  type?: string;
  person?: { email?: string | null };
};

export type NotionTokenResponse = {
  access_token: string;
  token_type?: string;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  owner?: { type?: string; user?: NotionOwnerUser } | null;
  duplicated_template_id?: string | null;
};

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

export async function exchangeNotionCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<NotionTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "Notion-Version": NOTION_VERSION,
      authorization: basicAuthHeader(args.clientId, args.clientSecret),
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`notion oauth exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as NotionTokenResponse;
}

// Best-effort: a revoked/uninstalled grant also stops working on its own.
export async function revokeNotionToken(args: {
  clientId: string;
  clientSecret: string;
  token: string;
}): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Notion-Version": NOTION_VERSION,
      authorization: basicAuthHeader(args.clientId, args.clientSecret),
    },
    body: JSON.stringify({ token: args.token }),
  }).catch(() => undefined);
}

export function notionOwnerEmail(token: NotionTokenResponse): string | null {
  return token.owner?.user?.person?.email ?? null;
}
