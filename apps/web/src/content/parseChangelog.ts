// Parses the public CHANGELOG.md into structured entries. The changelog is a
// plain markdown file where each release is an `## ` heading of the shape
// `YYYY-MM-DD — Title`, followed by markdown body. An optional `Tags:` line as
// the first body line becomes the entry's tag chips. Authors write entries
// newest-first; document order is preserved.

export type ChangelogEntry = {
  /** ISO date parsed from the heading, or "" if the heading has no date. */
  date: string;
  title: string;
  tags: string[];
  /** Markdown body (Tags: line stripped), trimmed. */
  body: string;
};

const HEADING_RE = /^##\s+(.*\S)\s*$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\s*(?:[—–-]\s*)?(.*)$/;
const TAGS_RE = /^tags:\s*(.+)$/i;

export function parseChangelog(input: string): ChangelogEntry[] {
  const lines = input.split("\n");
  const entries: ChangelogEntry[] = [];
  let current: { heading: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    entries.push(finishEntry(current.heading, current.body));
    current = null;
  };

  for (const line of lines) {
    const h = line.match(HEADING_RE);
    if (h) {
      flush();
      current = { heading: h[1]!, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return entries;
}

function finishEntry(heading: string, bodyLines: string[]): ChangelogEntry {
  let date = "";
  let title = heading.trim();
  const d = heading.match(DATE_RE);
  if (d) {
    date = d[1]!;
    title = d[2]!.trim();
  }

  let tags: string[] = [];
  const body = [...bodyLines];
  // Drop leading blank lines, then pull a Tags: line if it's first.
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  if (body.length > 0) {
    const m = body[0]!.match(TAGS_RE);
    if (m) {
      tags = m[1]!
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      body.shift();
    }
  }

  return { date, title, tags, body: body.join("\n").trim() };
}
