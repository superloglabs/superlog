import type { SentryIssue } from "./domain.js";

const SENTRY_API_ORIGIN = "https://sentry.io";

export async function listOpenSentryIssues(input: {
  accessToken: string;
  organizationSlug: string;
  projectSlug: string;
  fetchImpl?: typeof fetch;
}): Promise<SentryIssue[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let nextUrl: URL | null = new URL(
    `/api/0/organizations/${encodeURIComponent(input.organizationSlug)}/issues/`,
    SENTRY_API_ORIGIN,
  );
  nextUrl.searchParams.set("project", input.projectSlug);
  nextUrl.searchParams.set("query", "is:unresolved");
  nextUrl.searchParams.set("limit", "100");
  const visited = new Set<string>();
  const issues: SentryIssue[] = [];

  while (nextUrl) {
    if (visited.has(nextUrl.href)) throw new Error("Sentry API pagination loop detected");
    visited.add(nextUrl.href);
    const response = await fetchImpl(nextUrl.href, {
      headers: { accept: "application/json", authorization: `Bearer ${input.accessToken}` },
      redirect: "error",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Sentry issues request failed (${response.status})`);
    if (!Array.isArray(payload)) throw new Error("Sentry issues response was not a list");
    for (const value of payload) {
      const issue = parseIssue(value);
      if (!issue || issue.projectSlug !== input.projectSlug) {
        throw new Error("Sentry issues response contained an invalid issue");
      }
      issues.push(issue);
    }
    nextUrl = nextSentryPage(response.headers.get("link"));
  }

  return issues;
}

export async function sentryProjectIsAccessible(input: {
  accessToken: string;
  organizationSlug: string;
  projectSlug: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let nextUrl: URL | null = new URL(
    `/api/0/organizations/${encodeURIComponent(input.organizationSlug)}/projects/`,
    SENTRY_API_ORIGIN,
  );
  const visited = new Set<string>();

  while (nextUrl) {
    if (visited.has(nextUrl.href)) throw new Error("Sentry API pagination loop detected");
    visited.add(nextUrl.href);
    const response = await fetchImpl(nextUrl.href, {
      headers: { accept: "application/json", authorization: `Bearer ${input.accessToken}` },
      redirect: "error",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Sentry API request failed (${response.status})`);
    if (!Array.isArray(payload)) throw new Error("Sentry projects response was not a list");
    if (payload.some((project) => isRecord(project) && project.slug === input.projectSlug)) {
      return true;
    }
    nextUrl = nextSentryPage(response.headers.get("link"));
  }

  return false;
}

function nextSentryPage(linkHeader: string | null): URL | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,(?=\s*<)/)) {
    if (!/\brel="?next"?/i.test(part) || !/\bresults="?true"?/i.test(part)) continue;
    const href = part.match(/<([^>]+)>/)?.[1];
    if (!href) continue;
    const url = new URL(href, SENTRY_API_ORIGIN);
    if (url.origin !== SENTRY_API_ORIGIN) {
      throw new Error("Sentry API pagination escaped the Sentry Cloud origin");
    }
    return url;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIssue(value: unknown): SentryIssue | null {
  if (!isRecord(value) || !isRecord(value.project)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.project.slug !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    culprit: stringOrNull(value.culprit),
    level: stringOrNull(value.level),
    firstSeen: stringOrNull(value.firstSeen),
    lastSeen: stringOrNull(value.lastSeen),
    count: finiteNumber(value.count) ?? 0,
    url: stringOrNull(value.permalink),
    projectSlug: value.project.slug,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
