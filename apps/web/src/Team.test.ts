import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const landingSource = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");
const publicShellSource = await readFile(new URL("./content/PublicShell.tsx", import.meta.url), "utf8");
const teamSource = await readFile(new URL("./Team.tsx", import.meta.url), "utf8");

test("team page is available as a public /team route", () => {
  assert.match(appSource, /import \{ Team \} from "\.\/Team\.tsx";/);
  assert.match(appSource, /<Route path="\/team" element=\{<Team \/>\} \/>/);
});

test("landing and public content navigation link to the team page", () => {
  assert.match(landingSource, /href="\/team"[\s\S]*?Team\s*<\/a>/);
  assert.match(publicShellSource, /\{ href: "\/team", label: "Team" \}/);
});

test("public content navigation is constrained on narrow screens", () => {
  assert.match(publicShellSource, /className="[^"]*min-w-0[^"]*"/);
  assert.match(publicShellSource, /className="[^"]*overflow-x-auto[^"]*"/);
});

test("team page presents the active Superlog founders with local portraits", () => {
  for (const founder of ["Nicolò Magnante", "Arseniy Shishaev"]) {
    assert.match(teamSource, new RegExp(`name: "${founder}"`));
  }

  assert.match(teamSource, /role: "CEO"/);
  assert.match(teamSource, /role: "CTO"/);
  assert.match(teamSource, /image: "\/team\/nicolo-magnante\.jpg"/);
  assert.match(teamSource, /image: "\/team\/arseniy-shishaev\.jpg"/);
});

test("team page anchors the company context", () => {
  assert.match(teamSource, /Founded 2026 · YC Spring 2026 · San Francisco/);
  assert.match(teamSource, /delete the debugging loop/);
});

test("team page uses the dark public landing-page treatment", () => {
  assert.match(teamSource, /PublicShell/);
  assert.match(teamSource, /Meet the Superlog team/);
  assert.doesNotMatch(teamSource, /eyebrow="Team"/);
  assert.doesNotMatch(teamSource, /bg-\[#f8f7f2\]/);
  assert.doesNotMatch(teamSource, /superlog-wordmark-light/);
  assert.doesNotMatch(teamSource, /Backed by Y Combinator/);
  assert.match(teamSource, /profile-list/);
  assert.match(teamSource, /team-member-row/);
  assert.match(teamSource, /border-t border-border/);
  assert.doesNotMatch(teamSource, /TEAM_STATS/);
});

test("team page keeps the intro compact and starts profiles without an extra section", () => {
  assert.doesNotMatch(teamSource, /<section className="grid gap-4 border-t border-border pt-8 first:border-t-0 first:pt-0/);
  assert.match(teamSource, /index === 0 \? "border-t-0 pt-0" : "border-t border-border pt-8"/);
  assert.doesNotMatch(teamSource, /Why this team/);
  assert.doesNotMatch(teamSource, /The product combines native OpenTelemetry setup/);
});
