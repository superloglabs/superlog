import "../../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { incidentBlocks } from "./incident-messages.js";

function contextLine(blocks: unknown[]): string {
  const section = blocks[0] as { text: { text: string } };
  const lines = section.text.text.split("\n");
  return lines.at(-1) ?? "";
}

test("incidentBlocks renders project · service · environment as code chips", () => {
  const line = contextLine(
    incidentBlocks({
      emoji: "rotating_light",
      status: "New Incident",
      title: "boom",
      projectName: "Acme",
      service: "api",
      environment: "production",
      buttons: [],
    }),
  );
  assert.equal(line, "`Acme` · `api` · `production`");
});

test("incidentBlocks omits environment when absent", () => {
  const line = contextLine(
    incidentBlocks({
      emoji: "rotating_light",
      status: "New Incident",
      title: "boom",
      projectName: "Acme",
      service: "api",
      environment: null,
      buttons: [],
    }),
  );
  assert.equal(line, "`Acme` · `api`");
});

// Thread replies only reach us from channels the bot is a MEMBER of (posting
// works unjoined via chat:write.public — receiving does not). When the bot
// can't self-join (legacy install without channels:join, private channel) and
// isn't a member, the root notification must carry an invite hint so users
// learn replies are dead BEFORE they talk into the void.
test("needsInviteHint: join succeeded → no hint", async () => {
  const { needsInviteHint } = await import("./incident-messages.js");
  assert.equal(needsInviteHint({ ok: true }, null), false);
});

test("needsInviteHint: join failed but bot already a member → no hint", async () => {
  const { needsInviteHint } = await import("./incident-messages.js");
  assert.equal(needsInviteHint({ ok: false, error: "missing_scope" }, true), false);
});

test("needsInviteHint: join failed and bot not a member → hint", async () => {
  const { needsInviteHint } = await import("./incident-messages.js");
  assert.equal(needsInviteHint({ ok: false, error: "missing_scope" }, false), true);
});

test("needsInviteHint: membership unknown → no hint (never nag on flaky lookups)", async () => {
  const { needsInviteHint } = await import("./incident-messages.js");
  assert.equal(needsInviteHint({ ok: false, error: "missing_scope" }, null), false);
});

test("inviteHintBlock is a context block that tells the user to invite the bot", async () => {
  const { inviteHintBlock } = await import("./incident-messages.js");
  const block = inviteHintBlock() as {
    type: string;
    elements: Array<{ type: string; text: string }>;
  };
  assert.equal(block.type, "context");
  assert.ok(block.elements[0]?.text.includes("/invite"));
});
