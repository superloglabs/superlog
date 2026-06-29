import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECT_SECTIONS,
  connectActionFor,
  connectSectionsFor,
  isComingSoon,
  primaryConnectOption,
} from "./connectChoices.ts";

function findOption(sections: ReturnType<typeof connectSectionsFor>, id: string) {
  for (const section of sections) {
    const found = section.options.find((o) => o.id === id);
    if (found) return found;
  }
  return undefined;
}

test("integration-first: the primary option is a no-code integration (AWS), not the coding agent", () => {
  const primary = primaryConnectOption();
  assert.equal(primary.id, "aws");
  assert.equal(primary.action, "aws");
});

test("the recommended section is listed before the coding-agent section", () => {
  const recommendedIdx = CONNECT_SECTIONS.findIndex((s) => s.id === "recommended");
  const codeIdx = CONNECT_SECTIONS.findIndex((s) => s.id === "code");
  assert.ok(recommendedIdx >= 0 && codeIdx >= 0);
  assert.ok(recommendedIdx < codeIdx, "recommended integrations come first");
});

test("recommended + code options are all actionable; 'more' are coming soon", () => {
  for (const section of CONNECT_SECTIONS) {
    for (const option of section.options) {
      if (section.id === "more") {
        assert.equal(option.action, null, `${option.id} should be coming soon`);
        assert.equal(isComingSoon(option), true);
      } else {
        assert.notEqual(option.action, null, `${option.id} should be actionable`);
        assert.equal(isComingSoon(option), false);
      }
    }
  }
});

test("connectActionFor resolves known ids and returns null for coming-soon / unknown", () => {
  assert.equal(connectActionFor("aws"), "aws");
  assert.equal(connectActionFor("cloudflare"), "cloudflare");
  assert.equal(connectActionFor("otel"), "otel");
  assert.equal(connectActionFor("agent"), "code");
  assert.equal(connectActionFor("vercel"), null);
  assert.equal(connectActionFor("does-not-exist"), null);
});

test("connectSectionsFor disables Cloudflare when the connector isn't configured", () => {
  const gated = connectSectionsFor({ cloudflare: false });
  const cloudflare = findOption(gated, "cloudflare");
  assert.ok(cloudflare);
  assert.equal(cloudflare.action, null, "cloudflare should not be actionable when unavailable");
  assert.equal(isComingSoon(cloudflare), true);
  // Other options are untouched.
  assert.equal(findOption(gated, "aws")?.action, "aws");
});

test("connectSectionsFor leaves Cloudflare actionable when configured", () => {
  const enabled = connectSectionsFor({ cloudflare: true });
  assert.equal(findOption(enabled, "cloudflare")?.action, "cloudflare");
});

test("every option id is unique", () => {
  const ids = CONNECT_SECTIONS.flatMap((s) => s.options.map((o) => o.id));
  assert.equal(new Set(ids).size, ids.length);
});
