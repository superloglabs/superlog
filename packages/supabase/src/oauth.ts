export const SUPABASE_OAUTH_SCOPES = "projects:read database:read";

export type SupabaseOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function supabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseOAuthConfig | null {
  const clientId = env.SUPABASE_CLIENT_ID;
  const clientSecret = env.SUPABASE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: env.SUPABASE_OAUTH_REDIRECT_URI || "http://localhost:4100/supabase/oauth/callback",
  };
}

export function buildSupabaseAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://api.supabase.com/v1/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SUPABASE_OAUTH_SCOPES);
  url.searchParams.set("state", input.state);
  return url.toString();
}
