import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

test("createLinearAgentActivity posts a native response into the agent session", async () => {
  const { createLinearAgentActivity } = await import("./linear.js");
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: { id: "activity-1" },
          },
        },
      }),
      { status: 200 },
    );
  };

  try {
    const result = await createLinearAgentActivity({
      accessToken: "token",
      agentSessionId: "session-1",
      type: "response",
      body: "The checkout deploy introduced the regression.",
    });

    assert.deepEqual(result, { id: "activity-1" });
    const body = requestBody as { variables?: unknown } | null;
    assert.deepEqual(body?.variables, {
      input: {
        agentSessionId: "session-1",
        content: {
          type: "response",
          body: "The checkout deploy introduced the regression.",
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("updateLinearAgentSession links the delegated issue to its incident", async () => {
  const { updateLinearAgentSession } = await import("./linear.js");
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { agentSessionUpdate: { success: true } } }), {
      status: 200,
    });
  };

  try {
    await updateLinearAgentSession({
      accessToken: "token",
      agentSessionId: "session-1",
      externalUrls: [{ label: "View incident", url: "https://superlog.sh/incidents/inc-1" }],
    });

    const body = requestBody as { variables?: unknown } | null;
    assert.deepEqual(body?.variables, {
      id: "session-1",
      input: {
        externalUrls: [{ label: "View incident", url: "https://superlog.sh/incidents/inc-1" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
