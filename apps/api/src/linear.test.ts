import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "linear-test-secret-that-is-at-least-32-characters";

test("buildLinearAuthorizeUrl requests app-actor authorization", async () => {
  const { buildLinearAuthorizeUrl } = await import("./linear.js");
  const url = new URL(
    buildLinearAuthorizeUrl({
      clientId: "lin-client",
      redirectUrl: "https://api.superlog.sh/linear/oauth/callback",
      state: "signed-state",
    }),
  );

  assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "lin-client");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://api.superlog.sh/linear/oauth/callback",
  );
  assert.equal(
    url.searchParams.get("scope"),
    "read,write,issues:create,comments:create,app:mentionable,app:assignable",
  );
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("scope")?.includes("app:mentionable"), true);
  assert.equal(url.searchParams.get("scope")?.includes("app:assignable"), true);
});

test("a Linear agent session created from an @mention comment opens a chat", async () => {
  const { classifyLinearAgentSessionEvent } = await import("./linear.js");

  // A mention carries the triggering human comment: sourceMetadata.type === "comment".
  assert.deepEqual(
    classifyLinearAgentSessionEvent({
      type: "AgentSessionEvent",
      action: "created",
      promptContext: '<issue identifier="ENG-1"><title>Checkout is slow</title></issue>',
      agentSession: {
        id: "session-1",
        issueId: "issue-1",
        commentId: "comment-1",
        sourceMetadata: { type: "comment" },
      },
    }),
    {
      kind: "chat",
      agentSessionId: "session-1",
      issueId: "issue-1",
      prompt: '<issue identifier="ENG-1"><title>Checkout is slow</title></issue>',
    },
  );
});

test("a Linear agent session created from an issue opens an incident", async () => {
  const { classifyLinearAgentSessionEvent } = await import("./linear.js");

  assert.deepEqual(
    classifyLinearAgentSessionEvent({
      type: "AgentSessionEvent",
      action: "created",
      promptContext: "Investigate checkout failures",
      agentSession: { id: "session-2", issueId: "issue-2" },
    }),
    {
      kind: "incident",
      agentSessionId: "session-2",
      issueId: "issue-2",
      prompt: "Investigate checkout failures",
    },
  );
});

test("a delegation whose session has its own comment thread still opens an incident", async () => {
  const { classifyLinearAgentSessionEvent } = await import("./linear.js");

  // Assigning an issue to the agent (delegation) creates an AgentSession with its own
  // auto-created comment thread — `comment`/`commentId` is set — but there is NO
  // triggering source comment, so sourceMetadata is null. This must open an incident,
  // not a chat. Regression guard for the ENG-327 misclassification.
  assert.deepEqual(
    classifyLinearAgentSessionEvent({
      type: "AgentSessionEvent",
      action: "created",
      promptContext: '<issue identifier="ENG-2"><title>Block to usage over limit</title></issue>',
      agentSession: {
        id: "session-3",
        issueId: "issue-3",
        commentId: "container-comment-1",
        sourceMetadata: null,
      },
    }),
    {
      kind: "incident",
      agentSessionId: "session-3",
      issueId: "issue-3",
      prompt: '<issue identifier="ENG-2"><title>Block to usage over limit</title></issue>',
    },
  );
});

test("classification honours a source-metadata type resolved out of band", async () => {
  const { classifyLinearAgentSessionEvent } = await import("./linear.js");

  // When the webhook body omits sourceMetadata, the handler resolves it from Linear
  // and passes it in. "comment" => chat regardless of the (absent) payload field.
  assert.equal(
    classifyLinearAgentSessionEvent(
      {
        type: "AgentSessionEvent",
        action: "created",
        promptContext: "hey @superlog",
        agentSession: { id: "session-4", issueId: "issue-4", commentId: "c-4" },
      },
      { sourceMetadataType: "comment" },
    ).kind,
    "chat",
  );

  // Resolved null (a delegation) => incident even though a comment thread exists.
  assert.equal(
    classifyLinearAgentSessionEvent(
      {
        type: "AgentSessionEvent",
        action: "created",
        promptContext: "investigate",
        agentSession: { id: "session-5", issueId: "issue-5", commentId: "c-5" },
      },
      { sourceMetadataType: null },
    ).kind,
    "incident",
  );
});

test("a prompted Linear agent session continues its existing conversation", async () => {
  const { classifyLinearAgentSessionEvent } = await import("./linear.js");

  assert.deepEqual(
    classifyLinearAgentSessionEvent({
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: { id: "session-3", issueId: "issue-3" },
      agentActivity: { id: "activity-1", content: { type: "prompt", body: "Check deploys too" } },
    }),
    {
      kind: "continuation",
      agentSessionId: "session-3",
      activityId: "activity-1",
      prompt: "Check deploys too",
    },
  );
});

test("an application AgentSession webhook authenticates with the shared secret and app identity", async () => {
  const { authenticateLinearWebhook } = await import("./linear.js");
  const rawBody = JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    webhookId: "application-webhook",
    organizationId: "workspace-1",
    appUserId: "app-user-1",
  });
  const secret = "shared-application-webhook-secret";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const installation = { id: "installation-1" } as never;

  const result = await authenticateLinearWebhook({
    payload: JSON.parse(rawBody),
    rawBody,
    signature,
    appWebhookSecret: secret,
    findByWebhookId: async () => null,
    findByAgentIdentity: async (workspaceId, appUserId) => {
      assert.equal(workspaceId, "workspace-1");
      assert.equal(appUserId, "app-user-1");
      return installation;
    },
  });

  assert.deepEqual(result, { ok: true, installation });
});

test("completed is the only Linear state type that accepts the investigation", async () => {
  const { isLinearCompletedState, linearCompletionPlan } = await import("./linear.js");
  assert.equal(isLinearCompletedState("completed"), true);
  assert.equal(isLinearCompletedState("started"), false);
  assert.equal(isLinearCompletedState(undefined), false);
  assert.deepEqual(linearCompletionPlan("started", "completed"), {
    processCompletion: true,
    recordAcceptance: true,
  });
  assert.deepEqual(linearCompletionPlan("completed", "completed"), {
    processCompletion: true,
    recordAcceptance: false,
  });
});

test("Linear completion attributes the event without preserving the originating run", async () => {
  const { linearTicketResolutionInput } = await import("./linear.js");
  const input = linearTicketResolutionInput({
    id: "ticket-row-1",
    incidentId: "incident-1",
    agentRunId: "run-1",
    ticketId: "linear-id-1",
    ticketIdentifier: "ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
  } as never);

  assert.equal(input.agentRunId, "run-1");
  assert.equal(input.resolvingAgentRunId, null);
});
