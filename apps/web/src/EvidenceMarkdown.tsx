import { Fragment, type ReactNode, useEffect, useState } from "react";
import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import json from "shiki/langs/json.mjs";
import jsLang from "shiki/langs/javascript.mjs";
import tsLang from "shiki/langs/typescript.mjs";
import tsxLang from "shiki/langs/tsx.mjs";
import pyLang from "shiki/langs/python.mjs";
import sqlLang from "shiki/langs/sql.mjs";
import goLang from "shiki/langs/go.mjs";
import yamlLang from "shiki/langs/yaml.mjs";
import githubDarkDefault from "shiki/themes/github-dark-default.mjs";

// Renders the evidence markdown the agent run emits. The agent's
// output is a constrained subset of markdown:
//  - fenced code blocks with language tags
//  - bold inline (**text**)
//  - inline code (`text`)
//  - paragraphs separated by blank lines
//
// On top of that, we autolink:
//  - file paths like `apps/api/src/index.ts:42-60` → GitHub blob url
//  - 7-40 char hex commit SHAs → GitHub commit url
//  - bare http(s) urls
//  - trace IDs (32 hex) → /explore/traces?trace=…
//  - Linear ticket IDs (TEAM-123) → resolved via the per-agent-run Linear url
//
// All link generation is best-effort: if we don't know the repo url, we just
// render the text plain. The agent is asked to use these formats deliberately
// because they unlock the linking.

export type EvidenceLinkContext = {
  repoUrl?: string | null;
  baseBranch?: string | null;
  linearTicketUrl?: string | null;
  linearTicketId?: string | null;
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubDarkDefault],
    langs: [bash, json, jsLang, tsLang, tsxLang, pyLang, sqlLang, goLang, yamlLang],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

const LANG_ALIAS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
};

function resolveLang(raw: string): string {
  const key = raw.trim().toLowerCase();
  return LANG_ALIAS[key] ?? (key || "text");
}

type Block =
  | { kind: "para"; text: string }
  | {
      kind: "code";
      lang: string;
      code: string;
      // Optional citation header — set when the paragraph immediately preceding
      // the fence was a `**path/to/file.ext:LINE-LINE**`-only line. When set,
      // the code block uses this as its header instead of the language tag.
      citation?: { path: string; lineStart?: number; lineEnd?: number };
    };

type Citation = { path: string; lineStart?: number; lineEnd?: number };

// `**path/to/file.ext:LINE`, optionally `-LINE`, optionally with no line range — and nothing else on the line.
const CITATION_HEADING_RE =
  /^\*\*([a-zA-Z0-9_./-]+\.[a-zA-Z][a-zA-Z0-9]{0,6})(?::(\d+)(?:-(\d+))?)?\*\*$/;

function parseCitationHeading(text: string): Citation | null {
  const m = text.trim().match(CITATION_HEADING_RE);
  if (!m) return null;
  return {
    path: m[1]!,
    lineStart: m[2] ? Number(m[2]) : undefined,
    lineEnd: m[3] ? Number(m[3]) : undefined,
  };
}

function parseBlocks(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      // skip closing fence
      if (i < lines.length) i++;
      // If the previous block was a citation-only paragraph, fold it into the
      // code block as a citation header and drop it from the rendered list.
      let citation: Citation | undefined;
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "para") {
        const cite = parseCitationHeading(prev.text);
        if (cite) {
          citation = cite;
          blocks.pop();
        }
      }
      blocks.push({
        kind: "code",
        lang: resolveLang(lang),
        code: codeLines.join("\n"),
        ...(citation ? { citation } : {}),
      });
      continue;
    }
    // gather paragraph until blank line or fence
    const paraLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^```/.test(lines[i]!)) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: "para", text: paraLines.join("\n") });
    }
    // skip the blank line(s)
    while (i < lines.length && lines[i]!.trim() === "") i++;
  }
  return blocks;
}

export function EvidenceMarkdown({
  text,
  ctx,
}: {
  // Agent-emitted result fields are sometimes malformed (wrong type, missing).
  // Tolerate non-string input rather than crashing the page that renders us.
  text: string | null | undefined;
  ctx: EvidenceLinkContext;
}) {
  if (typeof text !== "string") return null;
  const blocks = parseBlocks(text.trim());
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-3 text-[12.5px] leading-relaxed text-fg">
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          <CodeBlock
            key={i}
            lang={block.lang}
            code={block.code}
            citation={block.citation}
            ctx={ctx}
          />
        ) : (
          <Paragraph key={i} text={block.text} ctx={ctx} />
        ),
      )}
    </div>
  );
}

function Paragraph({ text, ctx }: { text: string; ctx: EvidenceLinkContext }) {
  return (
    <p className="whitespace-pre-wrap break-words">
      <InlineMarkdown text={text} ctx={ctx} />
    </p>
  );
}

// Tokenises **bold**, `code`, and emits everything else through the autolinker.
function InlineMarkdown({ text, ctx }: { text: string; ctx: EvidenceLinkContext }) {
  const tokens: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(
        <AutoLinkText key={key++} text={text.slice(lastIndex, match.index)} ctx={ctx} />,
      );
    }
    const t = match[0]!;
    if (t.startsWith("**")) {
      tokens.push(
        <strong key={key++} className="font-semibold text-fg">
          <AutoLinkText text={t.slice(2, -2)} ctx={ctx} />
        </strong>,
      );
    } else {
      tokens.push(
        <code
          key={key++}
          className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[11.5px] text-fg"
        >
          <AutoLinkText text={t.slice(1, -1)} ctx={ctx} />
        </code>,
      );
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push(<AutoLinkText key={key++} text={text.slice(lastIndex)} ctx={ctx} />);
  }
  return <>{tokens}</>;
}

// Detects link-worthy substrings in plain text and wraps them in <a>.
function AutoLinkText({ text, ctx }: { text: string; ctx: EvidenceLinkContext }) {
  const segments = autolinkSegments(text, ctx);
  return (
    <>
      {segments.map((seg, i) =>
        seg.href ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {seg.text}
          </a>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

type Segment = { text: string; href?: string };

// Order matters: longer / more specific patterns first.
const PATTERNS: Array<{
  re: RegExp;
  href: (m: RegExpExecArray, ctx: EvidenceLinkContext) => string | null;
}> = [
  // raw URLs
  {
    re: /https?:\/\/[\w./?=&%#@:+~,-]+[\w/]/g,
    href: (m) => m[0]!,
  },
  // path/to/file.ext:LINE  or :LINE-LINE
  {
    re: /\b([a-zA-Z0-9_./-]+\.[a-zA-Z][a-zA-Z0-9]{0,6})(?::(\d+)(?:-(\d+))?)?\b/g,
    href: (m, ctx) => {
      if (!ctx.repoUrl) return null;
      const path = m[1]!;
      // skip non-path-looking matches (single token, no slash, plus an extension
      // that's just plain English like "a.m." would be filtered by the slash req)
      if (!path.includes("/")) return null;
      const branch = ctx.baseBranch ?? "main";
      const start = m[2];
      const end = m[3];
      const anchor = start ? `#L${start}${end ? `-L${end}` : ""}` : "";
      return `${stripTrailingSlash(ctx.repoUrl)}/blob/${branch}/${path}${anchor}`;
    },
  },
  // Trace ID (32 hex chars, lowercase) — must come before the commit pattern so a 32-char hex
  // resolves as a trace rather than a commit.
  {
    re: /\b([0-9a-f]{32})\b/g,
    href: (m) => `/explore/traces?trace=${m[1]}`,
  },
  // Commit SHA. Require length 7..12 (short SHA) or exactly 40 (full SHA), to avoid eating
  // 32-char trace IDs or random hex blobs.
  {
    re: /\b([0-9a-f]{7,12}|[0-9a-f]{40})\b/g,
    href: (m, ctx) => {
      if (!ctx.repoUrl) return null;
      return `${stripTrailingSlash(ctx.repoUrl)}/commit/${m[1]}`;
    },
  },
  // Linear ticket like ABC-123
  {
    re: /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g,
    href: (m, ctx) => {
      if (ctx.linearTicketUrl && ctx.linearTicketId === m[1]) return ctx.linearTicketUrl;
      // Fallback: best-effort guess at the workspace-less url won't work without a
      // workspace slug, so skip if we have nothing.
      return null;
    },
  },
];

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function autolinkSegments(text: string, ctx: EvidenceLinkContext): Segment[] {
  // Find all matches across all patterns, then take the leftmost-longest non-overlapping set.
  type Found = { start: number; end: number; href: string; text: string };
  const found: Found[] = [];
  for (const { re, href } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const url = href(m, ctx);
      if (!url) continue;
      found.push({ start: m.index, end: m.index + m[0]!.length, href: url, text: m[0]! });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const picked: Found[] = [];
  let cursor = 0;
  for (const f of found) {
    if (f.start < cursor) continue; // overlaps a previous pick
    picked.push(f);
    cursor = f.end;
  }
  if (picked.length === 0) return [{ text }];
  const segs: Segment[] = [];
  let pos = 0;
  for (const f of picked) {
    if (f.start > pos) segs.push({ text: text.slice(pos, f.start) });
    segs.push({ text: f.text, href: f.href });
    pos = f.end;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos) });
  return segs;
}

type HighlightedToken = {
  content: string;
  color?: string;
  fontStyle?: number;
  offset?: number;
};

function CodeBlock({
  lang,
  code,
  citation,
  ctx,
}: {
  lang: string;
  code: string;
  citation?: Citation;
  ctx: EvidenceLinkContext;
}) {
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    getHighlighter()
      .then((h) => {
        // Shiki throws if the lang isn't loaded; fall back to text.
        const loaded = new Set(h.getLoadedLanguages());
        const useLang = loaded.has(lang) ? lang : "text";
        return h.codeToTokens(code, { lang: useLang, theme: "github-dark-default" }).tokens;
      })
      .then((next) => {
        if (!cancelled) setTokens(next);
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="overflow-hidden border border-border bg-[#0d1117]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
        <CodeBlockHeader lang={lang} citation={citation} ctx={ctx} />
      </div>
      {tokens ? (
        <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed">
          <code>
            {tokens.map((line, lineIndex) => (
              <span key={lineIndex} className="block">
                {line.map((token, ti) => (
                  <span
                    key={ti}
                    style={{
                      color: token.color,
                      fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : undefined,
                      fontWeight: (token.fontStyle ?? 0) & 2 ? 700 : undefined,
                    }}
                  >
                    {token.content}
                  </span>
                ))}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-fg">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function CodeBlockHeader({
  lang,
  citation,
  ctx,
}: {
  lang: string;
  citation?: Citation;
  ctx: EvidenceLinkContext;
}) {
  if (citation) {
    const label =
      citation.path +
      (citation.lineStart
        ? `:${citation.lineStart}${citation.lineEnd ? `-${citation.lineEnd}` : ""}`
        : "");
    if (ctx.repoUrl) {
      const branch = ctx.baseBranch ?? "main";
      const anchor = citation.lineStart
        ? `#L${citation.lineStart}${citation.lineEnd ? `-L${citation.lineEnd}` : ""}`
        : "";
      const href = `${stripTrailingSlash(ctx.repoUrl)}/blob/${branch}/${citation.path}${anchor}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-[11px] text-accent hover:underline"
          title={`Open ${label} on GitHub`}
        >
          {label}
        </a>
      );
    }
    return (
      <span className="truncate font-mono text-[11px] text-muted">{label}</span>
    );
  }
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-subtle">
      {lang}
    </span>
  );
}
