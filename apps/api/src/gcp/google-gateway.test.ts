import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GoogleGcpGateway } from "./google-gateway.js";
import type { GcpConnectConfig } from "./interfaces.js";

const config: GcpConnectConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://api.example.com/gcp/oauth/callback",
  webOrigin: "https://app.example.com",
  integrationProjectId: "superlog-observability",
  readerServiceAccountEmail: "reader@superlog-observability.iam.gserviceaccount.com",
  pushServiceAccountEmail: "push@superlog-observability.iam.gserviceaccount.com",
  pushAudience: "https://intake.example.com/gcp/pubsub",
  pushEndpoint: "https://intake.example.com/gcp/pubsub",
};

test("customer authorization requests only the setup scopes the integration uses", () => {
  const gateway = new GoogleGcpGateway(config, fetch);
  const url = new URL(gateway.authorizationUrl({ state: "signed-state" }));

  assert.deepEqual(url.searchParams.get("scope")?.split(" ").sort(), [
    "https://www.googleapis.com/auth/cloudplatformprojects",
    "https://www.googleapis.com/auth/logging.admin",
  ]);
  assert.equal(url.searchParams.get("state"), "signed-state");
});

test("project discovery returns every active project across Google result pages", async () => {
  const requests: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    requests.push(url);
    if (url.searchParams.get("pageToken") === "next-page") {
      return Response.json({
        projects: [
          {
            name: "projects/222222222222",
            projectId: "beta-production",
            displayName: "Beta production",
            state: "ACTIVE",
          },
        ],
      });
    }
    return Response.json({
      projects: [
        {
          name: "projects/111111111111",
          projectId: "acme-production",
          displayName: "Acme production",
          state: "ACTIVE",
        },
      ],
      nextPageToken: "next-page",
    });
  };
  const gateway = new GoogleGcpGateway(config, fetchImpl);

  assert.deepEqual(await gateway.listProjects("temporary-user-token"), [
    {
      projectId: "acme-production",
      projectNumber: "111111111111",
      displayName: "Acme production",
    },
    {
      projectId: "beta-production",
      projectNumber: "222222222222",
      displayName: "Beta production",
    },
  ]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.pathname === "/v3/projects:search"));
  assert.ok(requests.every((url) => url.searchParams.get("query") === "state:ACTIVE"));
  assert.equal(requests[1]?.searchParams.get("pageToken"), "next-page");
});

test("Google API failures identify the operation that failed", async () => {
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    if (url.pathname.endsWith("/sinks") && init.method === "POST") {
      return Response.json({
        name: "superlog-connection-id",
        writerIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      });
    }
    if (url.hostname === "pubsub.googleapis.com" && url.pathname.endsWith(":getIamPolicy")) {
      return new Response(null, { status: 404 });
    }
    return Response.json({});
  };
  const gateway = new GoogleGcpGateway(config, fetchImpl, async () => "service-access-token");

  await assert.rejects(
    gateway.provision({
      connectionId: "connection-id",
      gcpProjectId: "acme-production",
      gcpProjectNumber: "123456789012",
      userAccessToken: "temporary-user-token",
      integrationProjectId: config.integrationProjectId,
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      pushServiceAccountEmail: config.pushServiceAccountEmail,
      pushAudience: config.pushAudience,
      pushEndpoint: `${config.pushEndpoint}/connection-id`,
    }),
    /GET pubsub\.googleapis\.com\/v1\/projects\/superlog-observability\/topics\/superlog-connection-id:getIamPolicy failed \(404\)/,
  );
});

test("provisioning keeps metered Pub/Sub resources and API quota in the integration project", async () => {
  const requests: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url, init, body });

    if (url.pathname === "/v1/projects/acme-production") {
      return Response.json({ projectNumber: "123456789012", projectId: "acme-production" });
    }
    if (url.pathname.endsWith(":getIamPolicy")) {
      return Response.json({ bindings: [], etag: "etag" });
    }
    if (url.pathname.endsWith(":setIamPolicy")) return Response.json(body.policy ?? {});
    if (url.pathname.endsWith("/sinks")) {
      return Response.json({
        name: "superlog-connection-id",
        writerIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      });
    }
    return Response.json({});
  };

  const gateway = new GoogleGcpGateway(config, fetchImpl, async () => "service-access-token");
  const provisioned = await gateway.provision({
    connectionId: "connection-id",
    gcpProjectId: "acme-production",
    userAccessToken: "temporary-user-token",
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    pushServiceAccountEmail: config.pushServiceAccountEmail,
    pushAudience: config.pushAudience,
    pushEndpoint: `${config.pushEndpoint}/connection-id`,
  });
  assert.equal(provisioned.monitoringViewerGrantCreated, true);

  const projectLookup = requests.find(
    (request) => request.url.hostname === "cloudresourcemanager.googleapis.com",
  );
  assert.equal(projectLookup?.url.pathname, "/v1/projects/acme-production");

  const topicCreate = requests.find((request) => request.url.pathname.includes("/topics/"));
  assert.ok(topicCreate);
  assert.match(topicCreate.url.pathname, /projects\/superlog-observability\/topics/);
  assert.equal(
    new Headers(topicCreate.init.headers).get("authorization"),
    "Bearer service-access-token",
  );

  const subscriptionCreate = requests.find((request) =>
    request.url.pathname.includes("/subscriptions/"),
  );
  assert.ok(subscriptionCreate);
  assert.match(subscriptionCreate.url.pathname, /projects\/superlog-observability\/subscriptions/);
  assert.equal(
    subscriptionCreate.body.topic,
    "projects/superlog-observability/topics/superlog-connection-id",
  );

  const sinkCreate = requests.find((request) => request.url.pathname.endsWith("/sinks"));
  assert.ok(sinkCreate);
  assert.match(sinkCreate.url.pathname, /projects\/acme-production\/sinks/);
  // The temporary customer identity is not an IAM principal in our project,
  // so free setup/control-plane calls omit a quota-project header. Ongoing
  // metered reads use our federated service identity (covered by the worker test).
  assert.equal(new Headers(sinkCreate.init.headers).get("x-goog-user-project"), null);
  assert.equal(
    sinkCreate.body.destination,
    "pubsub.googleapis.com/projects/superlog-observability/topics/superlog-connection-id",
  );

  const customerIam = requests.find(
    (request) =>
      request.url.hostname === "cloudresourcemanager.googleapis.com" &&
      request.url.pathname.endsWith(":setIamPolicy"),
  );
  assert.ok(customerIam);
  const policy = customerIam.body.policy as {
    bindings: Array<{ role: string; members: string[] }>;
  };
  assert.deepEqual(
    policy.bindings.map((binding) => binding.role),
    ["roles/monitoring.viewer"],
  );
  assert.ok(
    policy.bindings.every((binding) =>
      binding.members.includes(`serviceAccount:${config.readerServiceAccountEmail}`),
    ),
  );

  const topicPolicyRead = requests.find(
    (request) =>
      request.url.hostname === "pubsub.googleapis.com" &&
      request.url.pathname.endsWith(":getIamPolicy"),
  );
  assert.ok(topicPolicyRead);
  assert.equal(topicPolicyRead.init.method, "GET");
  assert.equal(topicPolicyRead.url.searchParams.get("options.requestedPolicyVersion"), "3");
  assert.deepEqual(topicPolicyRead.body, {});

  const projectPolicyRead = requests.find(
    (request) =>
      request.url.hostname === "cloudresourcemanager.googleapis.com" &&
      request.url.pathname.endsWith(":getIamPolicy"),
  );
  assert.ok(projectPolicyRead);
  assert.equal(projectPolicyRead.init.method, "POST");
  assert.deepEqual(projectPolicyRead.body, { options: { requestedPolicyVersion: 3 } });
});

test("provisioning reconciles an existing subscription push configuration", async () => {
  const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url, method, body });
    if (url.pathname === "/v1/projects/acme-production") {
      return Response.json({ projectNumber: "123456789012" });
    }
    if (url.pathname.endsWith(":getIamPolicy")) {
      return Response.json({ bindings: [], etag: "etag" });
    }
    if (url.pathname.endsWith(":setIamPolicy")) return Response.json(body.policy ?? {});
    if (url.pathname.endsWith("/sinks")) {
      return Response.json({
        name: "superlog-connection-id",
        writerIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      });
    }
    if (url.pathname.includes("/subscriptions/") && method === "PUT") {
      return Response.json({ error: { message: "already exists" } }, { status: 409 });
    }
    return Response.json({});
  };
  const gateway = new GoogleGcpGateway(config, fetchImpl, async () => "service-access-token");

  await gateway.provision({
    connectionId: "connection-id",
    gcpProjectId: "acme-production",
    userAccessToken: "temporary-user-token",
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    pushServiceAccountEmail: config.pushServiceAccountEmail,
    pushAudience: "https://intake.example.com/new-audience",
    pushEndpoint: "https://intake.example.com/new-endpoint/connection-id",
  });

  const patch = requests.find(
    (request) => request.url.pathname.includes("/subscriptions/") && request.method === "PATCH",
  );
  assert.ok(patch);
  assert.equal(patch.url.searchParams.get("updateMask"), null);
  assert.deepEqual(patch.body, {
    updateMask: "pushConfig,ackDeadlineSeconds,retryPolicy",
    subscription: {
      name: "projects/superlog-observability/subscriptions/superlog-connection-id",
      topic: "projects/superlog-observability/topics/superlog-connection-id",
      ackDeadlineSeconds: 30,
      pushConfig: {
        pushEndpoint: "https://intake.example.com/new-endpoint/connection-id",
        oidcToken: {
          serviceAccountEmail: config.pushServiceAccountEmail,
          audience: "https://intake.example.com/new-audience",
        },
      },
      retryPolicy: { minimumBackoff: "10s", maximumBackoff: "600s" },
    },
  });
});

test("deprovisioning preserves a monitoring viewer grant that predates the connection", async () => {
  const requests: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
  const readerMember = `serviceAccount:${config.readerServiceAccountEmail}`;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url, init, body });

    if (url.pathname === "/v1/projects/acme-production") {
      return Response.json({ projectNumber: "123456789012" });
    }
    if (url.pathname.endsWith(":getIamPolicy")) {
      return Response.json({
        bindings:
          url.hostname === "cloudresourcemanager.googleapis.com"
            ? [{ role: "roles/monitoring.viewer", members: [readerMember] }]
            : [],
        etag: "etag",
      });
    }
    if (url.pathname.endsWith(":setIamPolicy")) return Response.json(body.policy ?? {});
    if (url.pathname.endsWith("/sinks")) {
      return Response.json({
        name: "superlog-connection-id",
        writerIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      });
    }
    return Response.json({});
  };
  const gateway = new GoogleGcpGateway(config, fetchImpl, async () => "service-access-token");
  const provisioned = await gateway.provision({
    connectionId: "connection-id",
    gcpProjectId: "acme-production",
    userAccessToken: "temporary-user-token",
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    pushServiceAccountEmail: config.pushServiceAccountEmail,
    pushAudience: config.pushAudience,
    pushEndpoint: `${config.pushEndpoint}/connection-id`,
  });
  assert.equal(provisioned.monitoringViewerGrantCreated, false);

  await gateway.deprovision({
    connectionId: "connection-id",
    gcpProjectId: "acme-production",
    userAccessToken: "temporary-user-token",
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    provisioned,
  });

  const customerPolicyWrites = requests.filter(
    (request) =>
      request.url.hostname === "cloudresourcemanager.googleapis.com" &&
      request.url.pathname.endsWith(":setIamPolicy"),
  );
  assert.equal(customerPolicyWrites.length, 0);
});

test("replacement cleanup preserves Pub/Sub delivery when the old sink cannot be removed", async () => {
  const deletes: URL[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    if (init.method === "DELETE") {
      deletes.push(url);
      if (url.hostname === "logging.googleapis.com") {
        return Response.json({ error: { message: "permission denied" } }, { status: 403 });
      }
    }
    return Response.json({});
  };
  const gateway = new GoogleGcpGateway(config, fetchImpl, async () => "service-access-token");

  await assert.rejects(
    gateway.deprovision({
      connectionId: "old-connection-id",
      gcpProjectId: "acme-staging",
      userAccessToken: "temporary-user-token",
      integrationProjectId: config.integrationProjectId,
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      provisioned: {
        gcpProjectNumber: "987654321098",
        topicName: "superlog-old-connection-id",
        subscriptionName: "superlog-old-connection-id",
        logSinkName: "superlog-old-connection-id",
        logSinkWriterIdentity: "serviceAccount:old-cloud-logs@system.gserviceaccount.com",
        monitoringViewerGrantCreated: false,
      },
    }),
    /permission denied/,
  );

  assert.deepEqual(
    deletes.map((url) => url.hostname),
    ["logging.googleapis.com"],
  );
});

test("a later provisioning failure rolls back resources and IAM changes from that attempt", async () => {
  const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url, method, body });
    if (url.pathname === "/v1/projects/acme-production") {
      return Response.json({ projectNumber: "123456789012" });
    }
    if (url.pathname.endsWith(":getIamPolicy")) {
      return Response.json({
        bindings: [
          url.hostname === "pubsub.googleapis.com"
            ? {
                role: "roles/pubsub.publisher",
                members: ["serviceAccount:existing-publisher@example.iam.gserviceaccount.com"],
              }
            : {
                role: "roles/monitoring.viewer",
                members: ["serviceAccount:existing-reader@example.iam.gserviceaccount.com"],
              },
        ],
        etag: "original-etag",
        version: 3,
      });
    }
    if (url.pathname.endsWith(":setIamPolicy")) return Response.json(body.policy ?? {});
    if (url.pathname.endsWith("/sinks")) {
      return Response.json({
        name: "superlog-connection-id",
        writerIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      });
    }
    if (url.pathname.includes("/subscriptions/") && method === "PUT") {
      return Response.json({ error: { message: "subscription failed" } }, { status: 500 });
    }
    return Response.json({});
  };
  const gateway = new GoogleGcpGateway(config, fetchImpl, async () => "service-access-token");

  await assert.rejects(
    gateway.provision({
      connectionId: "connection-id",
      gcpProjectId: "acme-production",
      userAccessToken: "temporary-user-token",
      integrationProjectId: config.integrationProjectId,
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      pushServiceAccountEmail: config.pushServiceAccountEmail,
      pushAudience: config.pushAudience,
      pushEndpoint: `${config.pushEndpoint}/connection-id`,
    }),
    /subscription failed/,
  );

  const deletes = requests
    .filter((request) => request.method === "DELETE")
    .map((request) => request.url.pathname);
  assert.deepEqual(deletes, [
    "/v2/projects/acme-production/sinks/superlog-connection-id",
    "/v1/projects/superlog-observability/topics/superlog-connection-id",
  ]);
  const policyWrites = requests.filter((request) => request.url.pathname.endsWith(":setIamPolicy"));
  assert.equal(policyWrites.length, 4);
  assert.deepEqual(policyWrites[2]?.body.policy, {
    bindings: [
      {
        role: "roles/monitoring.viewer",
        members: ["serviceAccount:existing-reader@example.iam.gserviceaccount.com"],
      },
    ],
    etag: "original-etag",
    version: 3,
  });
  assert.deepEqual(policyWrites[3]?.body.policy, {
    bindings: [
      {
        role: "roles/pubsub.publisher",
        members: ["serviceAccount:existing-publisher@example.iam.gserviceaccount.com"],
      },
    ],
    etag: "original-etag",
    version: 3,
  });
});
