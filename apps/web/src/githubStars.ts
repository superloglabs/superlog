// ---------------------------------------------------------------------------
// GitHub star helpers — pure logic for the landing nav's live star badge.
// The React hook that fetches + caches lives in useGithubStars.ts; everything
// here is DOM-free so it can be unit-tested under `tsx --test`.
// ---------------------------------------------------------------------------

/**
 * Turn a public repo URL (`https://github.com/owner/repo`) into the REST API
 * endpoint that returns `{ stargazers_count }`. Tolerates a trailing slash and
 * a `.git` suffix. Returns null for anything that isn't an `owner/repo` URL on
 * github.com so callers can degrade gracefully instead of fetching garbage.
 */
export function githubApiUrlFromRepoUrl(repoUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return null;
  }
  const [owner, repoRaw] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!repo) return null;
  return `https://api.github.com/repos/${owner}/${repo}`;
}

/**
 * Compact, GitHub-style star count: exact below 1,000, then one-decimal `k`
 * and `M` with trailing `.0` trimmed (10_300 → "10.3k", 1_000 → "1k",
 * 1_200_000 → "1.2M"). Rounding-aware so 999_999 renders "1M", never "1000k".
 */
export function formatStarCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const n = Math.floor(count);
  if (n < 1000) return String(n);

  const format = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    const text = rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
    return `${text}${suffix}`;
  };

  // Pick the tier from the rounded magnitude so a value that rounds up across a
  // boundary (999_999 → 1,000.0k) promotes to the next suffix.
  const thousands = Math.round((n / 1000) * 10) / 10;
  if (thousands < 1000) return format(n / 1000, "k");
  return format(n / 1_000_000, "M");
}
