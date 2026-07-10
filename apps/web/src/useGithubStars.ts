import { useEffect, useState } from "react";
import { githubApiUrlFromRepoUrl } from "./githubStars.ts";

// ---------------------------------------------------------------------------
// useGithubStarCount — live star count for the landing nav badge.
// Fetches the public GitHub REST API straight from the visitor's browser and
// caches the result in localStorage so repeat visits render instantly and we
// stay well under the unauthenticated rate limit (60 req/hr per IP).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // refresh at most once per hour per visitor
const cacheKey = (apiUrl: string) => `superlog:gh-stars:${apiUrl}`;

type CachedStars = { count: number; at: number };

function readCache(apiUrl: string): CachedStars | null {
  try {
    const raw = localStorage.getItem(cacheKey(apiUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedStars>;
    if (typeof parsed?.count !== "number" || typeof parsed?.at !== "number") {
      return null;
    }
    return { count: parsed.count, at: parsed.at };
  } catch {
    return null;
  }
}

function writeCache(apiUrl: string, count: number) {
  try {
    localStorage.setItem(cacheKey(apiUrl), JSON.stringify({ count, at: Date.now() }));
  } catch {
    // Storage can be unavailable (private mode / quota) — the badge still works,
    // it just refetches next load.
  }
}

/**
 * Returns the repo's star count, or null until it's known. A cached value shows
 * immediately; a stale or missing cache triggers a background refresh. Every
 * failure mode (bad URL, offline, rate-limited, malformed body) resolves to the
 * cached value or null, so the caller can fall back to a static label and the
 * page never blocks on GitHub.
 */
export function useGithubStarCount(repoUrl: string): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const apiUrl = githubApiUrlFromRepoUrl(repoUrl);
    if (!apiUrl) return;

    const cached = readCache(apiUrl);
    if (cached) setCount(cached.count);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return;

    const controller = new AbortController();
    fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { stargazers_count?: unknown }) => {
        const stars = data?.stargazers_count;
        if (typeof stars === "number" && Number.isFinite(stars)) {
          setCount(stars);
          writeCache(apiUrl, stars);
        }
      })
      .catch(() => {
        // Keep whatever we already have (cached value or null).
      });

    return () => controller.abort();
  }, [repoUrl]);

  return count;
}
