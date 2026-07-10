import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LANDING_DOCS_URL, LANDING_GITHUB_REPO_URL } from "./landingLinks.ts";

test("landing navbar uses the public Superlog GitHub repository URL", () => {
  assert.equal(LANDING_GITHUB_REPO_URL, "https://github.com/superloglabs/superlog");
});

test("landing navbar uses the public Superlog docs URL", () => {
  assert.equal(LANDING_DOCS_URL, "https://docs.superlog.sh");
});

test("landing top nav renders a Docs link wired to the docs URL", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /href=\{LANDING_DOCS_URL\}[\s\S]*?target="_blank"[\s\S]*?rel="noreferrer"[\s\S]*?Docs\s*<\/a>/,
  );
});

test("landing top nav renders a GitHub link wired to the repository URL", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");

  // The link still opens the repo in a new tab and shows the octocat, but the
  // label is now the live star count (with a static "GitHub" fallback until the
  // count loads or if the API is unreachable).
  assert.match(
    source,
    /href=\{LANDING_GITHUB_REPO_URL\}[\s\S]*?target="_blank"[\s\S]*?rel="noreferrer"[\s\S]*?<GitHubIcon \/>[\s\S]*?formatStarCount\(stars\)[\s\S]*?"GitHub"[\s\S]*?<\/a>/,
  );
});

test("landing top nav feeds the live star count from the repo URL", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  // The count is derived from the same repo URL the link points at, so the
  // badge and the destination can never drift apart.
  assert.match(source, /useGithubStarCount\(LANDING_GITHUB_REPO_URL\)/);
});

test("landing footer links to the terms of service page", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /href="\/tos"[\s\S]*Terms of Service\s*<\/a>/);
  assert.match(appSource, /<Route path="\/tos" element=\{<TermsOfService \/>\} \/>/);
});

test("landing renders the client-logo marquee between the hero and the first content section", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  // The strip must sit just after the hero image and before the first text
  // section (id="install"), which is exactly where the design calls for it.
  assert.match(source, /<Hero \/>[\s\S]*<ClientLogos \/>[\s\S]*id="install"/);
});

test("client-logo marquee is a masked, animated, duplicated track", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  assert.match(source, /function ClientLogos\(/);
  // Edge-fade mask + the drifting track are what make it elegant.
  assert.match(source, /marquee-fade/);
  assert.match(source, /marquee-track/);
  // The track is duplicated so the loop is seamless.
  assert.match(source, /\[0, 1\]\.map/);
});

test("marquee animation is defined in CSS and disabled under reduced motion", async () => {
  const css = await readFile(new URL("./index.css", import.meta.url), "utf8");
  assert.match(css, /@keyframes superlog-marquee/);
  // Pin the guard INSIDE a reduced-motion media block — the marquee rule must be
  // that block's own content, not merely appear somewhere after the phrase (which
  // a greedy match could satisfy by spanning an unrelated earlier media block).
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.marquee-track \{\s*animation:\s*none/,
  );
});

test("client-logo marquee bundles real, white-filtered brand logos", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  // Logos are served from our own origin (public/logos), not a third-party CDN.
  assert.match(source, /src=\{logo\.src\}/);
  assert.match(source, /"\/logos\//);
  // Every logo is forced to one monochrome white regardless of its brand colors.
  assert.match(source, /brightness-0 invert/);
});

test("client-logo marquee lists all twelve companies", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  for (const name of [
    "Plato",
    "LightSprint",
    "Datost",
    "Clawvisor",
    "Akkari",
    "Nautilus",
    "Linzumi",
    "Kinect",
    "Juno",
    "Hedge",
    "Trellis",
    "Prism",
  ]) {
    assert.match(source, new RegExp(`name: "${name}"`));
  }
});

test("client-logo marquee shows a 'Trusted by teams at' eyebrow", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  assert.match(source, /Trusted by teams at/);
});

test("bare marks are labeled and image-less logos are typeset", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
  // Icon-only logos carry `icon: true`, rendering the name beside the mark so an
  // unlabeled glyph is never shown on its own.
  assert.match(source, /icon: true/);
  assert.match(source, /\{logo\.icon &&/);
  // Logos with no image render a typeset wordmark from label ?? name.
  assert.match(source, /\{!logo\.src &&/);
  assert.match(source, /logo\.label \?\? logo\.name/);
  assert.match(source, /label: "hedge\."/);
});
