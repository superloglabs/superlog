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

test("the chooser offers exactly three lanes: AWS, Cloudflare, and 'I'm hosted elsewhere'", () => {
  const ids = CONNECT_SECTIONS.flatMap((s) => s.options.map((o) => o.id));
  assert.deepEqual(ids, ["aws", "cloudflare", "elsewhere"]);
});

test("there is no coming-soon grid", () => {
  assert.equal(
    CONNECT_SECTIONS.find((s) => s.id === "more"),
    undefined,
    "no 'more integrations' coming-soon grid",
  );
});

test("the 'hosted elsewhere' lane routes to the coding-agent prompt (action 'code')", () => {
  const elsewhere = findOption(CONNECT_SECTIONS, "elsewhere");
  assert.ok(elsewhere);
  assert.equal(elsewhere.action, "code");
});

test("integration-first: the primary option is a no-code integration (AWS)", () => {
  const primary = primaryConnectOption();
  assert.equal(primary.id, "aws");
  assert.equal(primary.action, "aws");
});

test("every lane is actionable when its connector is configured", () => {
  const sections = connectSectionsFor({ cloudflare: true });
  for (const section of sections) {
    for (const option of section.options) {
      assert.notEqual(option.action, null, `${option.id} should be actionable`);
      assert.equal(isComingSoon(option), false);
    }
  }
});

test("connectActionFor resolves known ids and returns null for unknown", () => {
  assert.equal(connectActionFor("aws"), "aws");
  assert.equal(connectActionFor("cloudflare"), "cloudflare");
  assert.equal(connectActionFor("elsewhere"), "code");
  assert.equal(connectActionFor("does-not-exist"), null);
});

test("connectSectionsFor disables Cloudflare when the connector isn't configured", () => {
  const gated = connectSectionsFor({ cloudflare: false });
  const cloudflare = findOption(gated, "cloudflare");
  assert.ok(cloudflare);
  assert.equal(cloudflare.action, null, "cloudflare should not be actionable when unavailable");
  assert.equal(isComingSoon(cloudflare), true);
  // Other lanes are untouched.
  assert.equal(findOption(gated, "aws")?.action, "aws");
  assert.equal(findOption(gated, "elsewhere")?.action, "code");
});

test("connectSectionsFor leaves Cloudflare actionable when configured", () => {
  const enabled = connectSectionsFor({ cloudflare: true });
  assert.equal(findOption(enabled, "cloudflare")?.action, "cloudflare");
});

test("every option id is unique", () => {
  const ids = CONNECT_SECTIONS.flatMap((s) => s.options.map((o) => o.id));
  assert.equal(new Set(ids).size, ids.length);
});
