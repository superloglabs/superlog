import type { GcpConnectConfig } from "./interfaces.js";
import type { GcpGateway, GcpProvisioningInput, ProvisionedGcpConnection } from "./domain.js";

type AccessTokenProvider = () => Promise<string>;

type ErrorBody = { error?: { message?: string } };

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function responseError(response: Response): Promise<GoogleApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  return new GoogleApiError(
    response.status,
    body.error?.message ?? `Google API request failed (${response.status})`,
  );
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  init: RequestInit = {},
  quotaProject?: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json().catch(() => ({}))) as T;
}

async function ensureResource(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  body: unknown,
  quotaProject: string,
): Promise<void> {
  try {
    await requestJson(
      fetchImpl,
      url,
      accessToken,
      { method: "PUT", body: JSON.stringify(body) },
      quotaProject,
    );
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
  }
}

type IamPolicy = {
  bindings?: Array<{
    role: string;
    members: string[];
    condition?: { title?: string; expression?: string; description?: string };
  }>;
  etag?: string;
  version?: number;
};

function addMember(policy: IamPolicy, role: string, member: string): IamPolicy {
  const bindings = [...(policy.bindings ?? [])];
  // Never add a global integration principal to a conditional binding. If the
  // customer only has conditional bindings for this role, create a separate
  // unconditional binding for the explicit project-level grant.
  const existing = bindings.find((binding) => binding.role === role && !binding.condition);
  if (existing) {
    if (!existing.members.includes(member)) existing.members = [...existing.members, member];
  } else {
    bindings.push({ role, members: [member] });
  }
  return { ...policy, bindings };
}

export class GoogleGcpGateway implements GcpGateway {
  constructor(
    private readonly config: GcpConnectConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly serviceAccessToken: AccessTokenProvider = defaultServiceAccessToken,
  ) {}

  authorizationUrl({ state }: { state: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      [
        "https://www.googleapis.com/auth/logging.admin",
        "https://www.googleapis.com/auth/cloudplatformprojects",
      ].join(" "),
    );
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string }> {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token)
      throw new Error("Google OAuth response did not include an access token");
    return { accessToken: body.access_token };
  }

  async provision(input: GcpProvisioningInput): Promise<ProvisionedGcpConnection> {
    const serviceToken = await this.serviceAccessToken();
    const resourceSlug = `superlog-${input.connectionId}`;
    const topicPath = `projects/${input.integrationProjectId}/topics/${resourceSlug}`;
    const subscriptionPath = `projects/${input.integrationProjectId}/subscriptions/${resourceSlug}`;

    const project = await requestJson<{ name: string }>(
      this.fetchImpl,
      `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(input.gcpProjectId)}`,
      input.userAccessToken,
      {},
    );
    const gcpProjectNumber = project.name.split("/").at(-1);
    if (!gcpProjectNumber) throw new Error("Google Cloud project number was not returned");

    await ensureResource(
      this.fetchImpl,
      `https://pubsub.googleapis.com/v1/${topicPath}`,
      serviceToken,
      {},
      input.integrationProjectId,
    );

    let sink: { name: string; writerIdentity: string };
    try {
      sink = await requestJson(
        this.fetchImpl,
        `https://logging.googleapis.com/v2/projects/${encodeURIComponent(input.gcpProjectId)}/sinks?uniqueWriterIdentity=true`,
        input.userAccessToken,
        {
          method: "POST",
          body: JSON.stringify({
            name: resourceSlug,
            destination: `pubsub.googleapis.com/${topicPath}`,
            description: "Routes project logs to Superlog",
          }),
        },
      );
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
      sink = await requestJson(
        this.fetchImpl,
        `https://logging.googleapis.com/v2/projects/${encodeURIComponent(input.gcpProjectId)}/sinks/${resourceSlug}`,
        input.userAccessToken,
        {},
      );
    }

    const topicPolicyUrl = `https://pubsub.googleapis.com/v1/${topicPath}`;
    const topicPolicy = await requestJson<IamPolicy>(
      this.fetchImpl,
      `${topicPolicyUrl}:getIamPolicy`,
      serviceToken,
      { method: "POST", body: "{}" },
      input.integrationProjectId,
    );
    await requestJson(
      this.fetchImpl,
      `${topicPolicyUrl}:setIamPolicy`,
      serviceToken,
      {
        method: "POST",
        body: JSON.stringify({
          policy: addMember(topicPolicy, "roles/pubsub.publisher", sink.writerIdentity),
        }),
      },
      input.integrationProjectId,
    );

    const projectIamUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}`;
    const projectPolicy = await requestJson<IamPolicy>(
      this.fetchImpl,
      `${projectIamUrl}:getIamPolicy`,
      input.userAccessToken,
      { method: "POST", body: "{}" },
    );
    const readerPolicy = addMember(
      projectPolicy,
      "roles/monitoring.viewer",
      `serviceAccount:${input.readerServiceAccountEmail}`,
    );
    await requestJson(this.fetchImpl, `${projectIamUrl}:setIamPolicy`, input.userAccessToken, {
      method: "POST",
      body: JSON.stringify({ policy: readerPolicy }),
    });

    await ensureResource(
      this.fetchImpl,
      `https://pubsub.googleapis.com/v1/${subscriptionPath}`,
      serviceToken,
      {
        topic: topicPath,
        ackDeadlineSeconds: 30,
        pushConfig: {
          pushEndpoint: input.pushEndpoint,
          oidcToken: {
            serviceAccountEmail: input.pushServiceAccountEmail,
            audience: input.pushAudience,
          },
        },
        retryPolicy: { minimumBackoff: "10s", maximumBackoff: "600s" },
      },
      input.integrationProjectId,
    );

    return {
      gcpProjectNumber,
      topicName: resourceSlug,
      subscriptionName: resourceSlug,
      logSinkName: sink.name,
      logSinkWriterIdentity: sink.writerIdentity,
    };
  }
}

async function defaultServiceAccessToken(): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const scopes = ["https://www.googleapis.com/auth/cloud-platform"];
  const auth = new GoogleAuth({ scopes });
  const externalAccount = process.env.GCP_WORKLOAD_IDENTITY_CONFIG;
  const client = externalAccount
    ? auth.fromJSON({ ...JSON.parse(externalAccount), scopes })
    : await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token)
    throw new Error("Application Default Credentials did not return an access token");
  return token.token;
}
