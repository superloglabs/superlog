const SENTRY_API_ORIGIN = "https://sentry.io";

export type SentryInstallationToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

type SentryInstallationGrant =
  | { type: "authorization_code"; code: string }
  | { type: "refresh_token"; refreshToken: string };

export async function requestSentryInstallationToken(input: {
  installationId: string;
  clientId: string;
  clientSecret: string;
  grant: SentryInstallationGrant;
  fetchImpl?: typeof fetch;
}): Promise<SentryInstallationToken> {
  const body =
    input.grant.type === "authorization_code"
      ? {
          grant_type: input.grant.type,
          code: input.grant.code,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        }
      : {
          grant_type: input.grant.type,
          refresh_token: input.grant.refreshToken,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        };
  const response = await (input.fetchImpl ?? fetch)(
    `${SENTRY_API_ORIGIN}/api/0/sentry-app-installations/${encodeURIComponent(input.installationId)}/authorizations/`,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    },
  );
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const expiresAt = typeof payload?.expiresAt === "string" ? validDate(payload.expiresAt) : null;
  if (
    !response.ok ||
    typeof payload?.token !== "string" ||
    typeof payload.refreshToken !== "string" ||
    !expiresAt
  ) {
    throw new Error(`Sentry App authorization failed (${response.status})`);
  }
  return {
    accessToken: payload.token,
    refreshToken: payload.refreshToken,
    expiresAt,
  };
}

function validDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
