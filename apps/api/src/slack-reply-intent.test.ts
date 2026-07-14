import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyIncidentSlackReply } from "./slack-reply-intent.js";

test("keeps teammate conversation from resuming an incident", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });

    if (url.startsWith("https://slack.com/api/conversations.replies")) {
      return Response.json({
        ok: true,
        messages: [
          { ts: "100.1", user: "USUPERLOG", text: "Can someone confirm this is deployed?" },
          { ts: "101.1", user: "UKEVIN", text: "<@UJAMES> did this make it into prod?" },
          { ts: "102.1", user: "UJAMES", text: "not yet" },
        ],
      });
    }

    return Response.json({
      content: [
        {
          type: "tool_use",
          name: "classify_reply_intent",
          input: {
            decision: "not_intended",
            confidence: 0.99,
            reason: "The newest message answers the preceding teammate question.",
          },
        },
      ],
    });
  };

  const result = await classifyIncidentSlackReply(
    {
      botToken: "xoxb-test",
      botUserId: "USUPERLOG",
      channelId: "C123",
      threadTs: "100.1",
      currentMessage: { ts: "102.1", userId: "UJAMES", text: "not yet" },
    },
    {
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    },
  );

  assert.deepEqual(result, {
    decision: "not_intended",
    confidence: 0.99,
    reason: "The newest message answers the preceding teammate question.",
    source: "classifier",
  });
  assert.equal(calls.length, 2);
});

test("routes an unmentioned direct answer to Superlog's latest question", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://slack.com/api/conversations.replies")) {
      return Response.json({
        ok: true,
        messages: [
          {
            ts: "100.1",
            user: "USUPERLOG",
            text: "Was version 3.2.1 deployed before the errors started?",
          },
          { ts: "102.1", user: "UJAMES", text: "Yes, about ten minutes before." },
        ],
      });
    }

    return Response.json({
      content: [
        {
          type: "tool_use",
          name: "classify_reply_intent",
          input: {
            decision: "intended",
            confidence: 0.98,
            reason: "The newest message directly answers Superlog's latest question.",
          },
        },
      ],
    });
  };

  const result = await classifyIncidentSlackReply(
    {
      botToken: "xoxb-test",
      botUserId: "USUPERLOG",
      channelId: "C123",
      threadTs: "100.1",
      currentMessage: {
        ts: "102.1",
        userId: "UJAMES",
        text: "Yes, about ten minutes before.",
      },
    },
    { apiKey: "test-key", model: "test-model", fetchImpl },
  );

  assert.deepEqual(result, {
    decision: "intended",
    confidence: 0.98,
    reason: "The newest message directly answers Superlog's latest question.",
    source: "classifier",
  });
});

test("accepts an explicit Superlog mention without calling external services", async () => {
  let calls = 0;
  const result = await classifyIncidentSlackReply(
    {
      botToken: "xoxb-test",
      botUserId: "USUPERLOG",
      channelId: "C123",
      threadTs: "100.1",
      currentMessage: {
        ts: "103.1",
        userId: "UKEVIN",
        text: "<@USUPERLOG> please check whether this reached production",
      },
    },
    {
      apiKey: "",
      model: "test-model",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("explicit mentions should not make network calls");
      },
    },
  );

  assert.deepEqual(result, {
    decision: "intended",
    confidence: 1,
    reason: "The message explicitly mentions Superlog.",
    source: "explicit_mention",
  });
  assert.equal(calls, 0);
});

test("fails closed when the classifier is not confident enough", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://slack.com/api/conversations.replies")) {
      return Response.json({
        ok: true,
        messages: [
          { ts: "100.1", user: "USUPERLOG", text: "Which deploy introduced the error?" },
          { ts: "102.1", user: "UJAMES", text: "I think it was yesterday's deploy" },
        ],
      });
    }

    return Response.json({
      content: [
        {
          type: "tool_use",
          name: "classify_reply_intent",
          input: {
            decision: "intended",
            confidence: 0.6,
            reason: "This may answer the investigation question.",
          },
        },
      ],
    });
  };

  const result = await classifyIncidentSlackReply(
    {
      botToken: "xoxb-test",
      botUserId: "USUPERLOG",
      channelId: "C123",
      threadTs: "100.1",
      currentMessage: {
        ts: "102.1",
        userId: "UJAMES",
        text: "I think it was yesterday's deploy",
      },
    },
    { apiKey: "test-key", model: "test-model", fetchImpl },
  );

  assert.deepEqual(result, {
    decision: "not_intended",
    confidence: 0.6,
    reason: "Classifier confidence was below the routing threshold.",
    source: "fallback",
  });
});

test("fails closed when reply classification is unavailable", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://slack.com/api/conversations.replies")) {
      return Response.json({
        ok: true,
        messages: [{ ts: "102.1", user: "UJAMES", text: "not yet" }],
      });
    }
    return new Response("unavailable", { status: 503 });
  };

  const result = await classifyIncidentSlackReply(
    {
      botToken: "xoxb-test",
      botUserId: "USUPERLOG",
      channelId: "C123",
      threadTs: "100.1",
      currentMessage: { ts: "102.1", userId: "UJAMES", text: "not yet" },
    },
    { apiKey: "test-key", model: "test-model", fetchImpl },
  );

  assert.deepEqual(result, {
    decision: "not_intended",
    confidence: 0,
    reason: "Reply intent classification unavailable.",
    source: "fallback",
  });
});
