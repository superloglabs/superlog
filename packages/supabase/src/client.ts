import type { SupabaseOAuthConfig } from "./oauth.js";

export type SupabaseFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SupabaseToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
};

export type SupabaseProject = {
  ref: string;
  name: string;
  organizationSlug: string;
  region: string;
  status: string;
  databaseHost: string;
};

export type SupabaseProfile = {
  userId: string;
  primaryEmail: string;
  username: string;
};

export class SupabaseApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SupabaseApiError";
  }
}

export class SupabaseManagementClient {
  constructor(private readonly fetchImpl: SupabaseFetch = fetch) {}

  async exchangeCode(input: {
    config: SupabaseOAuthConfig;
    code: string;
  }): Promise<SupabaseToken> {
    return this.tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        redirect_uri: input.config.redirectUri,
        code: input.code,
      }),
    );
  }

  async refreshAccessToken(input: {
    config: SupabaseOAuthConfig;
    refreshToken: string;
    signal?: AbortSignal;
  }): Promise<SupabaseToken> {
    const token = await this.tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        refresh_token: input.refreshToken,
      }),
      input.signal,
    );
    return { ...token, refreshToken: token.refreshToken ?? input.refreshToken };
  }

  async listProjects(accessToken: string): Promise<SupabaseProject[]> {
    const response = await this.fetchImpl("https://api.supabase.com/v1/projects", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SupabaseApiError(
        response.status,
        `Supabase project discovery failed (${response.status})`,
      );
    }
    if (!Array.isArray(body))
      throw new Error("Supabase project discovery returned an invalid response");
    return body.map((value) => parseProject(value));
  }

  async getProfile(accessToken: string): Promise<SupabaseProfile> {
    const response = await this.fetchImpl("https://api.supabase.com/v1/profile", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new SupabaseApiError(
        response.status,
        `Supabase profile lookup failed (${response.status})`,
      );
    }
    if (
      !body ||
      typeof body.gotrue_id !== "string" ||
      typeof body.primary_email !== "string" ||
      typeof body.username !== "string"
    ) {
      throw new Error("Supabase profile lookup returned an invalid response");
    }
    return {
      userId: body.gotrue_id,
      primaryEmail: body.primary_email,
      username: body.username,
    };
  }

  async runReadOnlyQuery(input: {
    accessToken: string;
    projectRef: string;
    query: string;
    parameters?: unknown[];
    signal?: AbortSignal;
  }): Promise<Array<Record<string, unknown>>> {
    const response = await this.fetchImpl(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(input.projectRef)}/database/query/read-only`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          ...(input.parameters ? { parameters: input.parameters } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SupabaseApiError(
        response.status,
        `Supabase read-only query failed (${response.status})`,
      );
    }
    if (!Array.isArray(body))
      throw new Error("Supabase read-only query returned an invalid response");
    return body as Array<Record<string, unknown>>;
  }

  private async tokenRequest(body: URLSearchParams, signal?: AbortSignal): Promise<SupabaseToken> {
    const response = await this.fetchImpl("https://api.supabase.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      ...(signal ? { signal } : {}),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) {
      throw new SupabaseApiError(
        response.status,
        `Supabase OAuth token request failed (${response.status})`,
      );
    }
    if (
      typeof json.access_token !== "string" ||
      typeof json.expires_in !== "number" ||
      !Number.isFinite(json.expires_in)
    ) {
      throw new Error("Supabase OAuth returned an invalid token response");
    }
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresInSeconds: json.expires_in,
    };
  }
}

function parseProject(value: unknown): SupabaseProject {
  if (!value || typeof value !== "object") throw new Error("Supabase returned an invalid project");
  const row = value as Record<string, unknown>;
  const database = row.database as Record<string, unknown> | undefined;
  if (
    typeof row.ref !== "string" ||
    typeof row.name !== "string" ||
    typeof row.organization_slug !== "string" ||
    typeof row.region !== "string" ||
    typeof row.status !== "string" ||
    typeof database?.host !== "string"
  ) {
    throw new Error("Supabase returned an invalid project");
  }
  return {
    ref: row.ref,
    name: row.name,
    organizationSlug: row.organization_slug,
    region: row.region,
    status: row.status,
    databaseHost: database.host,
  };
}
