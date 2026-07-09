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

test("incidentBlocks renders the title as a link when titleUrl is set", () => {
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "New Incident",
    title: "boom",
    titleUrl: "https://app/incidents/inc-1",
    projectName: "Acme",
    service: "api",
    buttons: [],
  });
  const section = blocks[0] as { text: { text: string } };
  assert.match(section.text.text, /\*<https:\/\/app\/incidents\/inc-1\|boom>\*/);
  // The incident link no longer needs a standalone button.
  assert.equal(JSON.stringify(blocks).includes("open_superlog"), false);
});

test("incidentBlocks escapes angle brackets in a linked title", () => {
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "New Incident",
    title: "a < b > c & d",
    titleUrl: "https://app/incidents/inc-1",
    projectName: "Acme",
    buttons: [],
  });
  const section = blocks[0] as { text: { text: string } };
  assert.match(section.text.text, /a &lt; b &gt; c &amp; d/);
});

test("incidentBlocks renders auxiliary links as a body line", () => {
  const blocks = incidentBlocks({
    emoji: "bulb",
    status: "PR Ready",
    title: "boom",
    projectName: "Acme",
    buttons: [],
    links: [
      { text: "View PR", url: "https://gh/pr/1" },
      { text: "View ticket", url: "https://tix/1" },
    ],
  });
  const section = blocks[0] as { text: { text: string } };
  const line = section.text.text.split("\n").at(-1);
  assert.equal(line, "<https://gh/pr/1|View PR>  ·  <https://tix/1|View ticket>");
});

test("incidentBlocks percent-encodes | and > in link URLs so they can't break the mrkdwn link", () => {
  const blocks = incidentBlocks({
    emoji: "bulb",
    status: "PR Ready",
    title: "boom",
    titleUrl: "https://app/incidents/inc-1?q=a|b>c",
    projectName: "Acme",
    buttons: [],
    links: [{ text: "View PR", url: "https://gh/pr/1?x=y|z>w" }],
  });
  const text = (blocks[0] as { text: { text: string } }).text.text;
  // Raw `|`/`>` would truncate the <url|label> span; they must be encoded.
  assert.match(text, /<https:\/\/app\/incidents\/inc-1\?q=a%7Cb%3Ec\|boom>/);
  assert.match(text, /<https:\/\/gh\/pr\/1\?x=y%7Cz%3Ew\|View PR>/);
});

test("incidentBlocks renders 👍/👎 rating buttons when showFeedbackButtons is set", () => {
  const blocks = incidentBlocks({
    emoji: "bulb",
    status: "PR Ready",
    title: "boom",
    projectName: "Acme",
    buttons: [],
    incidentId: "inc-1",
    showFeedbackButtons: true,
  });
  const json = JSON.stringify(blocks);
  assert.equal(json.includes("rate_incident:helpful:inc-1"), true);
  assert.equal(json.includes("rate_incident:unhelpful:inc-1"), true);
  assert.equal(json.includes("👍 Helpful"), true);
  assert.equal(json.includes("👎 Not helpful"), true);
});

test("incidentBlocks omits rating buttons when showFeedbackButtons is unset", () => {
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "New Incident",
    title: "boom",
    projectName: "Acme",
    buttons: [],
    incidentId: "inc-1",
  });
  assert.equal(JSON.stringify(blocks).includes("rate_incident:"), false);
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
