// Landing page for the Railway OAuth callback redirect (`/connect/railway`).
// The consent screen opens in a new tab, so this is often the only surface the
// user sees after approving (or failing) the connection — it must state the
// result explicitly rather than relying on the onboarding wizard being mounted.

import { Btn, Wordmark } from "./design/ui.tsx";
import { CheckIcon } from "./onboarding/icons.tsx";
import { railwayCallbackView } from "./railwayCallbackModel.ts";

const SOFT_LINE = "border-[rgba(255,255,255,0.07)]";

export function RailwayCallback() {
  const params = new URLSearchParams(window.location.search);
  const view = railwayCallbackView(params.get("railway"));

  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="px-8 py-5">
        <Wordmark size="md" />
      </header>

      <main className="flex justify-center px-8 pb-16 pt-12">
        <div className="w-full max-w-[560px]">
          <div className="mb-7 px-1">
            <h1 className="m-0 text-[22px] font-semibold leading-[1.2] tracking-[-0.015em] text-fg">
              {view.title}
            </h1>
          </div>

          {view.tone === "success" ? (
            <div className="flex items-start gap-2.5 rounded-[10px] border border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)] px-4 py-3">
              <span className="mt-[2px] text-success">
                <CheckIcon size={14} />
              </span>
              <p className="m-0 flex-1 text-[13px] leading-[1.55] text-fg">{view.body}</p>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-[10px] border border-[rgba(240,98,98,0.35)] bg-[rgba(240,98,98,0.06)] px-4 py-3">
              <span className="mt-[2px] text-danger" aria-hidden>
                <ErrorIcon size={14} />
              </span>
              <p className="m-0 flex-1 text-[13px] leading-[1.55] text-fg">{view.body}</p>
            </div>
          )}

          <div className={`mt-9 flex items-center justify-end border-t pt-5 ${SOFT_LINE}`}>
            <Btn
              variant="primary"
              size="md"
              onClick={() => window.location.assign(view.backHref)}
              className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
            >
              {view.backLabel}
            </Btn>
          </div>
        </div>
      </main>
    </div>
  );
}

function ErrorIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" role="presentation">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.9" fill="currentColor" />
    </svg>
  );
}
