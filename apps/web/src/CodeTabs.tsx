import { useEffect, useState } from "react";
import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import json from "shiki/langs/json.mjs";
import githubDarkDefault from "shiki/themes/github-dark-default.mjs";

export type CodeTab = {
  id: string;
  label: string;
  language: string;
  code: string;
  icon: "anthropic" | "claude" | "cursor";
};

const iconPaths: Record<CodeTab["icon"], string> = {
  anthropic:
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  claude:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  cursor:
    "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

type HighlightedToken = {
  content: string;
  color?: string;
  fontStyle?: number;
  offset?: number;
};

export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? "");
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  if (!active) return null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
        <div
          role="tablist"
          aria-label="MCP setup target"
          className="flex min-w-0 flex-wrap items-end gap-1"
        >
          {tabs.map((tab) => {
            const selected = tab.id === active.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveId(tab.id)}
                className={`relative -mb-px inline-flex h-9 items-center gap-2 border-b-[2px] px-3 font-mono text-[12px] tracking-tight transition-colors ${
                  selected ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
                }`}
              >
                <BrandIcon icon={tab.icon} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <CopyButton code={active.code} />
      </div>
      <HighlightedCode code={active.code} language={active.language} />
    </div>
  );
}

function HighlightedCode({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);

    getHighlighter()
      .then(
        (highlighter) =>
          highlighter.codeToTokens(code, {
            lang: language,
            theme: "github-dark-default",
          }).tokens,
      )
      .then((nextTokens) => {
        if (!cancelled) setTokens(nextTokens);
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (!tokens) {
    return (
      <pre className="overflow-x-auto bg-[#0d1117] p-5 font-mono text-[12px] leading-relaxed text-fg">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <pre className="superlog-code overflow-x-auto bg-[#0d1117] p-5 font-mono text-[12px] leading-relaxed">
      <code>
        {tokens.map((line, lineIndex) => (
          <span key={`${lineIndex}-${line.length}`} className="block">
            {line.map((token) => (
              <span
                key={`${token.offset}-${token.content}`}
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
  );
}

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubDarkDefault],
    langs: [bash, json],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

function BrandIcon({ icon }: { icon: CodeTab["icon"] }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
      <path d={iconPaths[icon]} />
    </svg>
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy setup snippet"
      title="Copy"
      className="inline-flex h-9 items-center gap-2 bg-transparent px-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-fg"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="14" height="14" x="8" y="8" rx="1" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
