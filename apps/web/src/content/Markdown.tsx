import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders a subset of GitHub-flavoured markdown with the app's design tokens.
// Used by the public changelog and roadmap pages, which draw their content from
// markdown files in the repo. `inline` drops block spacing so a single bullet's
// text can sit inside a card without extra vertical rhythm.

const COMPONENTS: Components = {
  p: ({ children }) => <p className="leading-7 text-muted">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc space-y-1.5 pl-5 leading-7 text-muted marker:text-subtle">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1.5 pl-5 leading-7 text-muted marker:text-subtle">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noreferrer" : undefined}
      className="text-fg underline decoration-border underline-offset-4 transition-colors hover:decoration-fg"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-fg">
      {children}
    </code>
  ),
  h3: ({ children }) => (
    <h3 className="mt-6 text-[16px] font-semibold tracking-tight text-fg">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 text-[14px] font-semibold tracking-tight text-fg">{children}</h4>
  ),
};

export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  return (
    <div className={inline ? "" : "space-y-4 text-[15px] md:text-[16px]"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
