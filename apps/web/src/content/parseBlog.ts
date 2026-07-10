// Parses a single blog post markdown file. Posts open with a `---` fenced
// frontmatter block of simple `key: value` lines (title, date, author,
// excerpt), followed by the markdown body. The slug is derived from the
// filename by the loader (blogPosts.ts), not the frontmatter.

export type BlogPost = {
  slug: string;
  title: string;
  /** ISO date (YYYY-MM-DD) from the frontmatter. */
  date: string;
  author: string;
  /** Short summary shown on the index; optional. */
  excerpt: string;
  /** Markdown body with the frontmatter stripped, trimmed. */
  body: string;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseBlogPost(raw: string, slug: string): BlogPost {
  const match = raw.replace(/^﻿/, "").match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`blog post "${slug}" is missing its --- frontmatter block`);
  }
  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }

  const title = fields.title ?? "";
  const date = fields.date ?? "";
  if (!title) throw new Error(`blog post "${slug}" is missing a title`);
  if (!date) throw new Error(`blog post "${slug}" is missing a date`);

  return {
    slug,
    title,
    date,
    author: fields.author ?? "",
    excerpt: fields.excerpt ?? "",
    body: body.trim(),
  };
}
