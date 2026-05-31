import type { ReactNode } from "react";
import type { Widget } from "../types.ts";

type Block =
  | { id: string; kind: "heading"; text: string }
  | { id: string; kind: "paragraph"; text: string }
  | { id: string; kind: "list"; items: string[] };

function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let id = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ id: `paragraph-${id++}`, kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push({ id: `list-${id++}`, kind: "list", items: list });
    list = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ id: `heading-${id++}`, kind: "heading", text: heading[1] ?? "" });
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) {
      flushParagraph();
      list.push(item[1] ?? "");
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function InlineMarkdown({ text }: { text: string }) {
  const tokens: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (match.index > last) tokens.push(text.slice(last, match.index));
    const token = match[0] ?? "";
    if (token.startsWith("**")) {
      tokens.push(
        <strong key={key++} className="font-semibold text-fg">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      tokens.push(
        <code
          key={key++}
          className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-fg"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return <>{tokens}</>;
}

export function MarkdownWidget({ widget }: { widget: Widget }) {
  const markdown = widget.config.markdown?.trim();
  if (!markdown) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center font-mono text-[11px] text-subtle">
        empty note
      </div>
    );
  }

  const blocks = parseMarkdown(markdown);
  return (
    <div className="h-full min-h-[120px] overflow-auto pr-1 text-[13px] leading-relaxed text-muted">
      <div className="space-y-3">
        {blocks.map((block) => {
          if (block.kind === "heading") {
            return (
              <h3 key={block.id} className="text-[14px] font-semibold leading-snug text-fg">
                <InlineMarkdown text={block.text} />
              </h3>
            );
          }
          if (block.kind === "list") {
            return (
              <ul key={block.id} className="space-y-2">
                {block.items.map((item, itemIndex) => (
                  <li key={`${block.id}-${item}-${itemIndex}`} className="flex gap-2">
                    <span className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-subtle" />
                    <span className="min-w-0">
                      <InlineMarkdown text={item} />
                    </span>
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <p key={block.id}>
              <InlineMarkdown text={block.text} />
            </p>
          );
        })}
      </div>
    </div>
  );
}
