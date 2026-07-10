// Loads every markdown file under the repo-root `blog/` directory at build time
// and parses it into a BlogPost. Vite inlines the raw file contents via the
// eager glob, so no runtime fetch is involved. Posts are sorted newest-first.
//
// The slug is derived from the filename with any leading `YYYY-MM-DD-` date
// prefix stripped, so `blog/2026-07-10-quieter-incidents.md` is served at
// `/blog/quieter-incidents`.

import { type BlogPost, parseBlogPost } from "./content/parseBlog.ts";

const RAW = import.meta.glob("../../../blog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function slugFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

export const BLOG_POSTS: BlogPost[] = Object.entries(RAW)
  .map(([path, raw]) => parseBlogPost(raw, slugFromPath(path)))
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
