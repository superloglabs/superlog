import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LANDING_DOCS_URL, LANDING_GITHUB_REPO_URL } from "./landingLinks.ts";

test("landing navbar uses the public Superlog GitHub repository URL", () => {
  assert.equal(LANDING_GITHUB_REPO_URL, "https://github.com/superloglabs/superlog");
});

test("landing docs link points at the Mintlify docs site", () => {
  assert.equal(LANDING_DOCS_URL, "https://docs.superlog.sh");
});

test("landing top nav renders a Docs link wired to the docs URL", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");

  assert.match(source, /href=\{LANDING_DOCS_URL\}[\s\S]*?Docs\s*<\/a>/);
});

test("landing top nav renders a GitHub link wired to the repository URL", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /href=\{LANDING_GITHUB_REPO_URL\}[\s\S]*<GitHubIcon \/>[\s\S]*GitHub\s*<\/a>/,
  );
});

test("landing footer links to the terms of service page", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /href="\/tos"[\s\S]*Terms of Service\s*<\/a>/);
  assert.match(appSource, /<Route path="\/tos" element=\{<TermsOfService \/>\} \/>/);
});
