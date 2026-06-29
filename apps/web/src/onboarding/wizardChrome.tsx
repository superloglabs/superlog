import type { ReactNode } from "react";
import { Btn } from "../design/ui.tsx";
import { ArrowIcon, ArrowLeftIcon } from "./icons.tsx";

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
