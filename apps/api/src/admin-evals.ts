import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVALS_DIR = resolve(__dirname, "..", "..", "worker", "evals");
const INVESTIGATIONS_DIR = resolve(__dirname, "..", "..", "..", "evals", "investigations");

// Cap how many telemetry rows we ship to the admin UI per file. Investigation
// telemetry can be tens of thousands of rows; the detail page only needs a
// representative sample plus the true total.
const TELEMETRY_SAMPLE_LIMIT = 50;

export type IncidentEvalFixture = {
  file: string;
  incidentId: string;
  codename: string | null;
  capturedAt: string;
  userPrompt: string;
  referenceOutput: { title: string; summary: string | null };
  humanLabel: { title: string; summary: string; notes: string };
};

// Investigation fixtures are the agentic root-cause/fix evals under
// evals/investigations/<slug>/. The overview exposes only neutral metadata;
// the staff-only detail endpoint below is the place that includes the grader
// files for human review.
export type InvestigationEvalFixture = {
  slug: string;
  incidentId: string;
  title: string;
  service: string | null;
  window: { since: string | null; until: string | null };
  telemetryTables: string[];
  hasCode: boolean;
  hasGroundTruth: boolean;
  hasRubric: boolean;
};

export type AdminEvalsOverview = {
  incidentSummarization: {
    fixturesDir: string;
    fixtures: IncidentEvalFixture[];
    readError: string | null;
  };
  investigations: {
    fixturesDir: string;
    fixtures: InvestigationEvalFixture[];
    readError: string | null;
  };
};

export function loadEvalsOverview(): AdminEvalsOverview {
  return {
    incidentSummarization: loadIncidentFixtures(EVALS_DIR),
    investigations: loadInvestigationFixtures(INVESTIGATIONS_DIR),
  };
}

export function loadIncidentFixtures(
  evalsDir: string = EVALS_DIR,
): AdminEvalsOverview["incidentSummarization"] {
  const dir = resolve(evalsDir, "fixtures");
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const fixtures: IncidentEvalFixture[] = [];
    for (const file of entries) {
      try {
        const raw = readFileSync(resolve(dir, file), "utf8");
        const parsed = JSON.parse(raw) as Partial<IncidentEvalFixture>;
        fixtures.push({
          file,
          incidentId: String(parsed.incidentId ?? ""),
          codename: parsed.codename ?? null,
          capturedAt: String(parsed.capturedAt ?? ""),
          userPrompt: String(parsed.userPrompt ?? ""),
          referenceOutput: {
            title: String(parsed.referenceOutput?.title ?? ""),
            summary: parsed.referenceOutput?.summary ?? null,
          },
          humanLabel: {
            title: String(parsed.humanLabel?.title ?? ""),
            summary: String(parsed.humanLabel?.summary ?? ""),
            notes: String(parsed.humanLabel?.notes ?? ""),
          },
        });
      } catch {
        // skip malformed fixture
      }
    }
    return { fixturesDir: dir, fixtures, readError: null };
  } catch (err) {
    return { fixturesDir: dir, fixtures: [], readError: (err as Error).message };
  }
}

type RawInvestigationFixture = {
  slug?: string;
  incident?: {
    id?: string;
    title?: string;
    service?: string | null;
    window?: { since?: string; until?: string };
  };
  code?: { artifact?: string } | null;
  telemetry?: { files?: Array<{ table?: string; path?: string }> };
};

export function loadInvestigationFixtures(
  dir: string = INVESTIGATIONS_DIR,
): AdminEvalsOverview["investigations"] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      // Each case is its own directory; `_template` is the scaffold, not a case.
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
    const fixtures: InvestigationEvalFixture[] = [];
    for (const slug of entries) {
      const fixtureDir = resolve(dir, slug);
      const fixturePath = resolve(fixtureDir, "fixture.json");
      if (!existsSync(fixturePath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as RawInvestigationFixture;
        const incident = parsed.incident ?? {};
        fixtures.push({
          slug: String(parsed.slug ?? slug),
          incidentId: String(incident.id ?? ""),
          title: String(incident.title ?? ""),
          service: incident.service ?? null,
          window: {
            since: incident.window?.since ?? null,
            until: incident.window?.until ?? null,
          },
          telemetryTables: (parsed.telemetry?.files ?? [])
            .map((f) => f.table)
            .filter((t): t is string => typeof t === "string"),
          hasCode: Boolean(parsed.code?.artifact),
          hasGroundTruth: existsSync(resolve(fixtureDir, "ground_truth.md")),
          hasRubric: existsSync(resolve(fixtureDir, "rubric.json")),
        });
      } catch {
        // skip malformed fixture
      }
    }
    return { fixturesDir: dir, fixtures, readError: null };
  } catch (err) {
    return { fixturesDir: dir, fixtures: [], readError: (err as Error).message };
  }
}

// Full detail for a single investigation fixture. This is staff-only admin
// surface, so unlike the agent's bundle it intentionally includes the grader's
// answer key (ground_truth.md + rubric.json). A human reviewer needs to see
// what "correct" looks like to judge the eval.
export type InvestigationEvalDetail = {
  slug: string;
  fixturesDir: string;
  incident: {
    id: string;
    title: string;
    service: string | null;
    window: { since: string | null; until: string | null };
  };
  fixture: unknown;
  groundTruth: string | null;
  rubric: unknown | null;
  postgres: Array<{ file: string; json: unknown }>;
  telemetry: Array<{ table: string; path: string; rowCount: number; sample: unknown[] }>;
  code: { artifact: string; bytes: number } | null;
  readError: string | null;
};

// Slugs are directory names like `2026-04-27-cross-org-project-403`. Anything
// with a path separator, `..`, or other funny business is rejected before we
// touch the filesystem.
function isSafeSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== "." && slug !== ".." && !slug.startsWith("_");
}

function readJsonlSample(path: string, limit: number): { rowCount: number; sample: unknown[] } {
  const fd = openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = "";
  let rowCount = 0;
  const sample: unknown[] = [];

  const processLine = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    rowCount += 1;
    if (sample.length >= limit) return;
    try {
      sample.push(JSON.parse(line));
    } catch {
      // skip a malformed row but still count it
    }
  };

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    const finalLine = carry + decoder.end();
    processLine(finalLine);
  } finally {
    closeSync(fd);
  }

  return { rowCount, sample };
}

export function loadInvestigationFixtureDetail(
  slug: string,
  dir: string = INVESTIGATIONS_DIR,
): InvestigationEvalDetail | null {
  if (!isSafeSlug(slug)) return null;
  const root = resolve(dir);
  const fixtureDir = resolve(root, slug);
  // Defense in depth: the resolved path must stay inside the investigations root.
  if (fixtureDir !== root && !fixtureDir.startsWith(root + sep)) return null;
  const fixturePath = resolve(fixtureDir, "fixture.json");
  if (!existsSync(fixturePath)) return null;

  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RawInvestigationFixture;
    const incident = fixture.incident ?? {};

    const groundTruthPath = resolve(fixtureDir, "ground_truth.md");
    const groundTruth = existsSync(groundTruthPath) ? readFileSync(groundTruthPath, "utf8") : null;

    const rubricPath = resolve(fixtureDir, "rubric.json");
    let rubric: unknown = null;
    if (existsSync(rubricPath)) {
      try {
        rubric = JSON.parse(readFileSync(rubricPath, "utf8"));
      } catch {
        rubric = null;
      }
    }

    const postgres: InvestigationEvalDetail["postgres"] = [];
    const pgDir = resolve(fixtureDir, "postgres");
    if (existsSync(pgDir)) {
      for (const file of readdirSync(pgDir)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        try {
          postgres.push({ file, json: JSON.parse(readFileSync(resolve(pgDir, file), "utf8")) });
        } catch {
          // skip malformed postgres fixture file
        }
      }
    }

    const telemetry: InvestigationEvalDetail["telemetry"] = [];
    for (const f of fixture.telemetry?.files ?? []) {
      if (typeof f.table !== "string" || typeof f.path !== "string") continue;
      const telPath = resolve(fixtureDir, f.path);
      // Telemetry paths come from fixture.json (trusted, in-repo) but keep them
      // inside the fixture dir anyway.
      if (!telPath.startsWith(fixtureDir + sep) || !existsSync(telPath)) {
        telemetry.push({ table: f.table, path: f.path, rowCount: 0, sample: [] });
        continue;
      }
      const { rowCount, sample } = readJsonlSample(telPath, TELEMETRY_SAMPLE_LIMIT);
      telemetry.push({ table: f.table, path: f.path, rowCount, sample });
    }

    let code: InvestigationEvalDetail["code"] = null;
    if (fixture.code?.artifact) {
      const artifactPath = resolve(fixtureDir, fixture.code.artifact);
      const bytes =
        artifactPath.startsWith(fixtureDir + sep) && existsSync(artifactPath)
          ? statSync(artifactPath).size
          : 0;
      code = { artifact: fixture.code.artifact, bytes };
    }

    return {
      slug: String(fixture.slug ?? slug),
      fixturesDir: root,
      incident: {
        id: String(incident.id ?? ""),
        title: String(incident.title ?? ""),
        service: incident.service ?? null,
        window: {
          since: incident.window?.since ?? null,
          until: incident.window?.until ?? null,
        },
      },
      fixture,
      groundTruth,
      rubric,
      postgres,
      telemetry,
      code,
      readError: null,
    };
  } catch (err) {
    return {
      slug,
      fixturesDir: root,
      incident: { id: "", title: "", service: null, window: { since: null, until: null } },
      fixture: null,
      groundTruth: null,
      rubric: null,
      postgres: [],
      telemetry: [],
      code: null,
      readError: (err as Error).message,
    };
  }
}
