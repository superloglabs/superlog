import { Btn, Wordmark } from "./design/ui.tsx";
import { CheckIcon } from "./onboarding/icons.tsx";
import { gcpCallbackView } from "./gcpCallbackModel.ts";

export function GcpCallback() {
  const view = gcpCallbackView(new URLSearchParams(window.location.search).get("gcp"));
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="px-8 py-5">
        <Wordmark size="md" />
      </header>
      <main className="flex justify-center px-8 pb-16 pt-12">
        <div className="w-full max-w-[560px]">
          <h1 className="mb-7 text-[22px] font-semibold tracking-[-0.015em]">{view.title}</h1>
          <div
            className={`flex items-start gap-2.5 rounded-[10px] border px-4 py-3 ${
              view.tone === "success"
                ? "border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)]"
                : "border-[rgba(240,98,98,0.35)] bg-[rgba(240,98,98,0.06)]"
            }`}
          >
            <span
              className={`mt-[2px] ${view.tone === "success" ? "text-success" : "text-danger"}`}
            >
              {view.tone === "success" ? <CheckIcon size={14} /> : "!"}
            </span>
            <p className="m-0 flex-1 text-[13px] leading-[1.55] text-fg">{view.body}</p>
          </div>
          <div className="mt-9 flex justify-end border-t border-[rgba(255,255,255,0.07)] pt-5">
            <Btn variant="primary" size="md" onClick={() => window.location.assign(view.backHref)}>
              {view.backLabel}
            </Btn>
          </div>
        </div>
      </main>
    </div>
  );
}
