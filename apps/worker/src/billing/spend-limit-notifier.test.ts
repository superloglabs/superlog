import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type SpendLimitNotice,
  type SpendLimitNotifierDeps,
  buildSpendLimitIncidentSlackText,
  buildSpendLimitSlackText,
  notifySpendLimit,
} from "./spend-limit-notifier.js";

const MANAGE_URL = "https://example.test/billing";
const NOW = new Date(Date.UTC(2026, 10, 15));

function harness(overrides: Partial<SpendLimitNotifierDeps> = {}) {
  const emails: Array<{ email: string; notice: SpendLimitNotice }> = [];
  const slack: string[] = [];
  const claims: Array<{ periodKey: string; steps: number[] }> = [];
  const won = new Set<string>();
  const deps: SpendLimitNotifierDeps = {
    claimSteps: async (_orgId, periodKey, steps) => {
      claims.push({ periodKey, steps });
      return steps.filter((step) => {
        const key = `${periodKey}:${step}`;
        if (won.has(key)) return false;
        won.add(key);
        return true;
      });
    },
    fetchMembers: async () => [{ email: "a@example.test" }, { email: "b@example.test" }],
    fetchOrgName: async () => "Acme",
    sendEmail: async (email, notice) => {
      emails.push({ email, notice });
    },
    postSlack: async (_orgId, text) => {
      slack.push(text);
    },
    manageBillingUrl: MANAGE_URL,
    now: () => NOW,
    ...overrides,
  };
  return { deps, emails, slack, claims };
}

const under = (pct: number) =>
  ({
    status: "under",
    billUsd: pct,
    limitUsd: 100,
    pct,
    resetsAt: Date.UTC(2026, 11, 1),
  }) as const;
const reached = {
  status: "reached",
  billUsd: 101,
  limitUsd: 100,
  pct: 101,
  resetsAt: Date.UTC(2026, 11, 1),
} as const;

test("nothing is sent or claimed below the warning step", async () => {
  const { deps, emails, slack, claims } = harness();

  await notifySpendLimit(deps, { orgId: "org", limitCents: 10_000, state: under(79) });

  assert.deepEqual(claims, []);
  assert.deepEqual(emails, []);
  assert.deepEqual(slack, []);
});

test("crossing 80% warns every member and Slack once", async () => {
  const { deps, emails, slack } = harness();
  const input = { orgId: "org", limitCents: 10_000, state: under(85) };

  await notifySpendLimit(deps, input);
  await notifySpendLimit(deps, input);

  assert.deepEqual(
    emails.map(({ email }) => email),
    ["a@example.test", "b@example.test"],
  );
  assert.equal(emails[0]?.notice.reached, false);
  assert.equal(slack.length, 1);
});

test("jumping straight to the limit sends only the reached notice", async () => {
  const { deps, emails, slack } = harness();

  await notifySpendLimit(deps, { orgId: "org", limitCents: 10_000, state: reached });

  assert.equal(emails.length, 2);
  assert.equal(emails[0]?.notice.reached, true);
  assert.equal(slack.length, 1);
});

test("the ledger key follows the cycle and the limit", async () => {
  const { deps, claims } = harness();

  await notifySpendLimit(deps, { orgId: "org", limitCents: 10_000, state: reached });

  assert.equal(claims[0]?.periodKey, "spend:2026-12-01:10000");
});

test("one failed email doesn't stop the others or Slack", async () => {
  const delivered: string[] = [];
  const { deps, slack } = harness({
    sendEmail: async (email) => {
      if (email === "a@example.test") throw new Error("bounced");
      delivered.push(email);
    },
  });

  await notifySpendLimit(deps, { orgId: "org", limitCents: 10_000, state: reached });

  assert.deepEqual(delivered, ["b@example.test"]);
  assert.equal(slack.length, 1);
});

test("the reached Slack message says what stopped and how to resume", () => {
  const text = buildSpendLimitSlackText({
    orgName: "Acme",
    billUsd: 101,
    limitUsd: 100,
    pct: 101,
    reached: true,
    manageBillingUrl: MANAGE_URL,
  });

  assert.match(text, /Acme/);
  assert.match(text, /\$100\.00/);
  assert.match(text, /new telemetry beyond your included allowance is being dropped/);
  assert.match(text, /billable investigations are paused/);
  assert.match(text, new RegExp(MANAGE_URL));
});

test("the warning Slack message shows the bill against the limit", () => {
  const text = buildSpendLimitSlackText({
    orgName: "Acme",
    billUsd: 82.5,
    limitUsd: 100,
    pct: 82,
    reached: false,
    manageBillingUrl: MANAGE_URL,
  });

  assert.match(text, /82%/);
  assert.match(text, /\$82\.50/);
});

test("the incident message points at the spend limit, not an upgrade", () => {
  const text = buildSpendLimitIncidentSlackText({ manageBillingUrl: MANAGE_URL });

  assert.match(text, /monthly spend limit/);
  assert.doesNotMatch(text, /Free plan/);
});
