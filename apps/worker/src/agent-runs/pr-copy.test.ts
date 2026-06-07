import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrBody, buildPrTitle } from "./pr-copy.js";

test("buildPrTitle prefers explicit PR title and keeps a single superlog prefix", () => {
  const title = buildPrTitle({
    ctx: { incident: { id: "inc-1", title: "API returns 403" } },
    result: { summary: "summary", proposedTitle: "Allow members to access projects" },
    pr: { title: "[superlog] Allow members to access projects outside the active org" },
  });

  assert.equal(title, "[superlog] Allow members to access projects outside the active org");
});

test("buildPrTitle falls back to proposedTitle without adding Fix to the incident title", () => {
  const title = buildPrTitle({
    ctx: { incident: { id: "inc-1", title: "API returns 403" } },
    result: {
      summary: "summary",
      proposedTitle: "Allow members to access projects outside the active org",
    },
    pr: {},
  });

  assert.equal(title, "[superlog] Allow members to access projects outside the active org");
});

test("buildPrBody fallback only includes summary and incident link", () => {
  const body = buildPrBody({
    incidentUrl: "https://superlog.sh/incidents/inc-1",
    result: { summary: "Users get an Unauthorized error." },
    pr: {},
  });

  assert.equal(
    body,
    [
      "# Summary",
      "",
      "Users get an Unauthorized error.",
      "",
      "[Incident on Superlog](https://superlog.sh/incidents/inc-1)",
    ].join("\n"),
  );
  assert.ok(!body.includes("Motivation"));
  assert.ok(!body.includes("Testing"));
  assert.ok(!body.includes("Changed files"));
});

test("buildPrBody falls back to the generated summary for a whitespace-only body", () => {
  const body = buildPrBody({
    incidentUrl: "https://superlog.sh/incidents/inc-1",
    result: { summary: "Users get an Unauthorized error." },
    pr: { body: "   \n  " },
  });

  assert.equal(
    body,
    [
      "# Summary",
      "",
      "Users get an Unauthorized error.",
      "",
      "[Incident on Superlog](https://superlog.sh/incidents/inc-1)",
    ].join("\n"),
  );
});

test("buildPrBody appends a linked Linear reference when the run filed a ticket", () => {
  const body = buildPrBody({
    incidentUrl: "https://superlog.sh/incidents/inc-1",
    result: {
      summary: "Users get an Unauthorized error.",
      linearTicket: { id: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" },
    },
    pr: { body: "# Summary\n\nFix the auth check." },
  });

  assert.ok(body.startsWith("# Summary\n\nFix the auth check."));
  assert.ok(body.endsWith("\n\nLinear: [ENG-123](https://linear.app/acme/issue/ENG-123)"));
});

test("buildPrBody falls back to a bare Linear id when the ticket has no URL", () => {
  const body = buildPrBody({
    incidentUrl: "https://superlog.sh/incidents/inc-1",
    result: {
      summary: "Users get an Unauthorized error.",
      linearTicket: { id: "ENG-123", url: null },
    },
    pr: {},
  });

  assert.ok(body.includes("[Incident on Superlog](https://superlog.sh/incidents/inc-1)"));
  assert.ok(body.endsWith("\n\nLinear: ENG-123"));
});

test("buildPrBody does not duplicate a Linear reference the agent already wrote", () => {
  const body = buildPrBody({
    incidentUrl: "https://superlog.sh/incidents/inc-1",
    result: {
      summary: "summary",
      linearTicket: { id: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" },
    },
    pr: { body: "# Summary\n\nAlready tracked in ENG-123." },
  });

  assert.equal(body, "# Summary\n\nAlready tracked in ENG-123.");
});
