import { createAwsFederatedGcpClient } from "@superlog/gcp-auth";
import type {
  GcpDeprovisioningInput,
  GcpGateway,
  GcpProjectOption,
  GcpProvisioningInput,
  ProvisionedGcpConnection,
} from "./domain.js";
import type { GcpConnectConfig } from "./interfaces.js";

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

async function responseError(response: Response, operation: string): Promise<GoogleApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const detail = body.error?.message;
  return new GoogleApiError(
    response.status,
    detail ? `${operation}: ${detail}` : `${operation} failed (${response.status})`,
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
  if (!response.ok) {
    const parsed = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    throw await responseError(response, `${method} ${parsed.hostname}${parsed.pathname}`);
  }
  return (await response.json().catch(() => ({}))) as T;
}

async function ensureResource(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  body: unknown,
  quotaProject: string,
): Promise<boolean> {
  try {
    await requestJson(
      fetchImpl,
      url,
      accessToken,
      { method: "PUT", body: JSON.stringify(body) },
      quotaProject,
    );
    return true;
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
    return false;
  }
}

async function deleteResource(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  quotaProject?: string,
): Promise<void> {
  try {
    await requestJson(fetchImpl, url, accessToken, { method: "DELETE" }, quotaProject);
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 404) throw error;
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
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...binding.members],
  }));
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

function hasMember(policy: IamPolicy, role: string, member: string): boolean {
  return (policy.bindings ?? []).some(
    (binding) => binding.role === role && !binding.condition && binding.members.includes(member),
  );
}

function removeMember(policy: IamPolicy, role: string, member: string): IamPolicy {
  const bindings = (policy.bindings ?? []).flatMap((binding) => {
    if (binding.role !== role || binding.condition || !binding.members.includes(member)) {
      return [binding];
    }
    const members = binding.members.filter((candidate) => candidate !== member);
    return members.length > 0 ? [{ ...binding, members }] : [];
  });
  return { ...policy, bindings };
}

async function bestEffort(actions: Array<() => Promise<void>>): Promise<void> {
  for (const action of actions) {
    try {
      await action();
    } catch {
      // Preserve the provisioning failure. A subsequent connection retry can
      // reconcile deterministic resource names if compensation is incomplete.
    }
  }
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
    if (!response.ok) throw await responseError(response, "POST oauth2.googleapis.com/token");
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token)
      throw new Error("Google OAuth response did not include an access token");
    return { accessToken: body.access_token };
  }

  async listProjects(userAccessToken: string): Promise<GcpProjectOption[]> {
    const projects: GcpProjectOption[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = new URL("https://cloudresourcemanager.googleapis.com/v3/projects:search");
      url.searchParams.set("query", "state:ACTIVE");
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await requestJson<{
        projects?: Array<{
          name?: string;
          projectId?: string;
          displayName?: string;
          state?: string;
        }>;
        nextPageToken?: string;
      }>(this.fetchImpl, url.toString(), userAccessToken);
      for (const project of page.projects ?? []) {
        const projectNumber = project.name?.match(/^projects\/(\d+)$/)?.[1];
        if (project.state !== "ACTIVE" || !project.projectId || !projectNumber) continue;
        projects.push({
          projectId: project.projectId,
          projectNumber,
          displayName: project.displayName?.trim() || project.projectId,
        });
      }
      pageToken = page.nextPageToken || undefined;
      if (pageToken && seenPageTokens.has(pageToken)) {
        throw new Error("Google Cloud project search returned a repeated page token");
      }
      if (pageToken) seenPageTokens.add(pageToken);
    } while (pageToken);
    return projects;
  }

  async provision(input: GcpProvisioningInput): Promise<ProvisionedGcpConnection> {
    const serviceToken = await this.serviceAccessToken();
    const resourceSlug = `superlog-${input.connectionId}`;
    const topicPath = `projects/${input.integrationProjectId}/topics/${resourceSlug}`;
    const subscriptionPath = `projects/${input.integrationProjectId}/subscriptions/${resourceSlug}`;

    let gcpProjectNumber = input.gcpProjectNumber;
    if (!gcpProjectNumber) {
      const project = await requestJson<{ projectNumber?: string }>(
        this.fetchImpl,
        `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}`,
        input.userAccessToken,
        {},
      );
      gcpProjectNumber = project.projectNumber;
      if (!gcpProjectNumber) throw new Error("Google Cloud project number was not returned");
    }

    let topicCreated = false;
    let sinkCreated = false;
    let topicPolicyBefore: IamPolicy | null = null;
    let topicPolicyChanged = false;
    let projectPolicyBefore: IamPolicy | null = null;
    let projectPolicyChanged = false;
    let sink: { name: string; writerIdentity: string };
    try {
      topicCreated = await ensureResource(
        this.fetchImpl,
        `https://pubsub.googleapis.com/v1/${topicPath}`,
        serviceToken,
        {},
        input.integrationProjectId,
      );

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
        sinkCreated = true;
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
      topicPolicyBefore = await requestJson<IamPolicy>(
        this.fetchImpl,
        `${topicPolicyUrl}:getIamPolicy?options.requestedPolicyVersion=3`,
        serviceToken,
        { method: "GET" },
        input.integrationProjectId,
      );
      if (!hasMember(topicPolicyBefore, "roles/pubsub.publisher", sink.writerIdentity)) {
        await requestJson(
          this.fetchImpl,
          `${topicPolicyUrl}:setIamPolicy`,
          serviceToken,
          {
            method: "POST",
            body: JSON.stringify({
              policy: addMember(topicPolicyBefore, "roles/pubsub.publisher", sink.writerIdentity),
            }),
          },
          input.integrationProjectId,
        );
        topicPolicyChanged = true;
      }

      const projectIamUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}`;
      projectPolicyBefore = await requestJson<IamPolicy>(
        this.fetchImpl,
        `${projectIamUrl}:getIamPolicy`,
        input.userAccessToken,
        {
          method: "POST",
          body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
        },
      );
      const readerMember = `serviceAccount:${input.readerServiceAccountEmail}`;
      if (!hasMember(projectPolicyBefore, "roles/monitoring.viewer", readerMember)) {
        await requestJson(this.fetchImpl, `${projectIamUrl}:setIamPolicy`, input.userAccessToken, {
          method: "POST",
          body: JSON.stringify({
            policy: addMember(projectPolicyBefore, "roles/monitoring.viewer", readerMember),
          }),
        });
        projectPolicyChanged = true;
      }

      const subscriptionUrl = `https://pubsub.googleapis.com/v1/${subscriptionPath}`;
      const subscription = {
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
      };
      const subscriptionCreated = await ensureResource(
        this.fetchImpl,
        subscriptionUrl,
        serviceToken,
        subscription,
        input.integrationProjectId,
      );
      if (!subscriptionCreated) {
        const updateMask = "pushConfig,ackDeadlineSeconds,retryPolicy";
        await requestJson(
          this.fetchImpl,
          subscriptionUrl,
          serviceToken,
          {
            method: "PATCH",
            body: JSON.stringify({
              subscription: {
                name: subscriptionPath,
                ...subscription,
              },
              updateMask,
            }),
          },
          input.integrationProjectId,
        );
      }

      return {
        gcpProjectNumber,
        topicName: resourceSlug,
        subscriptionName: resourceSlug,
        logSinkName: sink.name,
        logSinkWriterIdentity: sink.writerIdentity,
        monitoringViewerGrantCreated: projectPolicyChanged,
      };
    } catch (error) {
      const topicPolicyUrl = `https://pubsub.googleapis.com/v1/${topicPath}`;
      const projectIamUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}`;
      await bestEffort([
        ...(projectPolicyChanged && projectPolicyBefore
          ? [
              () =>
                requestJson<void>(
                  this.fetchImpl,
                  `${projectIamUrl}:setIamPolicy`,
                  input.userAccessToken,
                  {
                    method: "POST",
                    body: JSON.stringify({ policy: projectPolicyBefore }),
                  },
                ),
            ]
          : []),
        ...(topicPolicyChanged && topicPolicyBefore
          ? [
              () =>
                requestJson<void>(
                  this.fetchImpl,
                  `${topicPolicyUrl}:setIamPolicy`,
                  serviceToken,
                  {
                    method: "POST",
                    body: JSON.stringify({ policy: topicPolicyBefore }),
                  },
                  input.integrationProjectId,
                ),
            ]
          : []),
        ...(sinkCreated
          ? [
              () =>
                deleteResource(
                  this.fetchImpl,
                  `https://logging.googleapis.com/v2/projects/${encodeURIComponent(input.gcpProjectId)}/sinks/${resourceSlug}`,
                  input.userAccessToken,
                ),
            ]
          : []),
        ...(topicCreated
          ? [
              () =>
                deleteResource(
                  this.fetchImpl,
                  `https://pubsub.googleapis.com/v1/${topicPath}`,
                  serviceToken,
                  input.integrationProjectId,
                ),
            ]
          : []),
      ]);
      throw error;
    }
  }

  async deprovision(input: GcpDeprovisioningInput): Promise<void> {
    const serviceToken = await this.serviceAccessToken();
    const resourceSlug = `superlog-${input.connectionId}`;
    // Remove the customer-owned sink first. If the temporary user no longer has
    // access to that project, leave the integration-owned delivery resources in
    // place so the currently connected path is not partially dismantled.
    await deleteResource(
      this.fetchImpl,
      `https://logging.googleapis.com/v2/projects/${encodeURIComponent(input.gcpProjectId)}/sinks/${input.provisioned.logSinkName}`,
      input.userAccessToken,
    );
    const actions: Array<() => Promise<void>> = [
      () =>
        deleteResource(
          this.fetchImpl,
          `https://pubsub.googleapis.com/v1/projects/${input.integrationProjectId}/subscriptions/${resourceSlug}`,
          serviceToken,
          input.integrationProjectId,
        ),
      () =>
        deleteResource(
          this.fetchImpl,
          `https://pubsub.googleapis.com/v1/projects/${input.integrationProjectId}/topics/${resourceSlug}`,
          serviceToken,
          input.integrationProjectId,
        ),
    ];
    if (input.provisioned.monitoringViewerGrantCreated) {
      const projectIamUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}`;
      const projectPolicy = await requestJson<IamPolicy>(
        this.fetchImpl,
        `${projectIamUrl}:getIamPolicy`,
        input.userAccessToken,
        {
          method: "POST",
          body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
        },
      );
      const readerMember = `serviceAccount:${input.readerServiceAccountEmail}`;
      if (hasMember(projectPolicy, "roles/monitoring.viewer", readerMember)) {
        actions.push(() =>
          requestJson<void>(
            this.fetchImpl,
            `${projectIamUrl}:setIamPolicy`,
            input.userAccessToken,
            {
              method: "POST",
              body: JSON.stringify({
                policy: removeMember(projectPolicy, "roles/monitoring.viewer", readerMember),
              }),
            },
          ),
        );
      }
    }
    const results = await Promise.allSettled(actions.map((action) => action()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "GCP cleanup failed");
  }
}

async function defaultServiceAccessToken(): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const scopes = ["https://www.googleapis.com/auth/cloud-platform"];
  const externalAccount = process.env.GCP_WORKLOAD_IDENTITY_CONFIG;
  const client = externalAccount
    ? createAwsFederatedGcpClient(externalAccount)
    : await new GoogleAuth({ scopes }).getClient();
  const token = await client.getAccessToken();
  if (!token.token)
    throw new Error("Application Default Credentials did not return an access token");
  return token.token;
}
