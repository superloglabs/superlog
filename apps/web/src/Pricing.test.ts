import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./Pricing.tsx", import.meta.url), "utf8");

test("pricing page offers an Enterprise plan", () => {
  assert.match(source, /name:\s*"Enterprise"/);
});

test("Enterprise plan uses a Contact us call to action", () => {
  // The Enterprise plan is contact-sales, not self-serve sign-up — its CTA
  // must read "Contact us" rather than the "Get started" used by self-serve packs.
  assert.match(source, /cta:\s*"Contact us"/);
});

test("Enterprise plan links its CTA to the discovery call URL", () => {
  // Self-serve packs open the sign-up modal; Enterprise instead routes to the
  // booking link, so the plan must carry an explicit contact href.
  assert.match(source, /href:\s*ENTERPRISE_CONTACT_URL/);
  assert.match(source, /ENTERPRISE_CONTACT_URL\s*=\s*"https:\/\/cal\.com\/superlog\/yc"/);
});
