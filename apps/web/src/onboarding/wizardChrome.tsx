import { type ReactNode, useState } from "react";
import { Btn } from "../design/ui.tsx";
import { INSTALL_PROMPT, buildInstallPrompt } from "../installPrompt.ts";
import { TruncatedKey } from "./TruncatedKey.tsx";
import { ArrowIcon, ArrowLeftIcon, CheckIcon, CopyIcon, SpinnerIcon } from "./icons.tsx";

// Shared chrome for the onboarding wizard steps, extracted so the install /
// deploy flow and the new "Connect your data" views render identical headers,
// footers, and hairlines.
//
// Hairlines matching the playground's --sl-line / --sl-line-2 tokens. Host's
// `border-border` reads as a boxed line on the dark canvas; the playground uses
// translucent whites for the soft elevation effect.
export const SOFT_LINE = "border-[rgba(255,255,255,0.07)]";
export const STRONG_LINE = "border-[rgba(255,255,255,0.12)]";

export function StepHeader({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="m-0 text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-fg">
        {title}
      </h1>
      <div className="mt-2.5 max-w-[540px] text-[14px] text-muted">{sub}</div>
    </div>
  );
}

export function StepFooter({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  onSkip,
  skipLabel,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <div className={`mt-9 flex items-center justify-between gap-2 border-t pt-5 ${SOFT_LINE}`}>
      <div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg"
          >
            <ArrowLeftIcon />
            Back
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="inline-flex items-center px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg"
          >
            {skipLabel ?? "Skip"}
          </button>
        )}
        <Btn
          variant="primary"
          size="md"
          onClick={onNext}
          disabled={nextDisabled}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {nextLabel}
          <ArrowIcon />
        </Btn>
      </div>
    </div>
  );
}

// The copyable coding-agent prompt, terminal-styled. Shared so the "Connect
// your data" chooser can render it inline and the deploy dialog can reuse the
// same block. The `apiKey` is minted by the caller and baked into the copied
// text; the key is write-only, so it's safe to surface directly.
export function InstallPromptCard({
  apiKey,
  minting,
  error,
}: {
  apiKey: string | null;
  minting: boolean;
  error: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const prompt = apiKey ? buildInstallPrompt(apiKey) : INSTALL_PROMPT;

  const copy = () => {
    try {
      navigator.clipboard?.writeText(prompt);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`overflow-hidden rounded-[14px] border bg-[#0a0a0c] ${SOFT_LINE}`}>
      <div
        className={`flex items-center justify-between gap-2.5 border-b px-[18px] py-[8px] ${SOFT_LINE}`}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex gap-1.5">
            <span className="h-[10px] w-[10px] rounded-full bg-[#3b3b3e]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#3b3b3e]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#3b3b3e]" />
          </span>
          <span className="ml-2 text-[11px] uppercase tracking-[0.08em] text-subtle">
            coding agent
          </span>
        </div>
        <Btn
          variant="primary"
          size="sm"
          onClick={copy}
          disabled={!apiKey}
          className="!h-[26px] !rounded-[8px] !px-[10px]"
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? "Copied" : "Copy"}
        </Btn>
      </div>
      <div className="px-[22px] py-[18px]">
        <div className="text-[13.5px] leading-[1.5] text-fg">
          <p className="m-0 break-words">{INSTALL_PROMPT}</p>
          {minting ? (
            <p className="m-0 mt-1 inline-flex items-center gap-2 text-muted">
              <SpinnerIcon size={13} /> Provisioning your API key…
            </p>
          ) : error ? (
            <p className="m-0 mt-1 text-danger">{error}</p>
          ) : apiKey ? (
            <p className="m-0 mt-1 whitespace-nowrap">
              Use API key{" "}
              <TruncatedKey value={apiKey} className="font-mono text-[12px] text-[#8C98F0]" />.
            </p>
          ) : null}
        </div>
        <p className="mt-2.5 text-[11.5px] leading-[1.5] text-subtle">
          The key is write-only — it can only ingest events, not read them — and you can rotate it
          any time from settings. Safe to drop straight into your agent.
        </p>
      </div>
    </div>
  );
}

// Subtle escape hatch shown only when a shared demo project is configured: lets
// a new user explore sample data before instrumenting. The connect flow stays
// the primary path; this is a secondary, lower-emphasis action.
export function ExploreDemoLink({ onExploreDemo }: { onExploreDemo?: () => void }) {
  if (!onExploreDemo) return null;
  return (
    <div className="mt-3 text-right">
      <button
        type="button"
        onClick={onExploreDemo}
        className="pr-1 text-[12.5px] font-medium text-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
      >
        Not ready yet? Explore with sample data first →
      </button>
    </div>
  );
}
