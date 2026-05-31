import { useEffect, useRef, useState } from "react";
import { type Stats, useCreateKey, useStats } from "../api.ts";
import { Btn } from "../design/ui.tsx";
import { buildInstallPrompt, INSTALL_PROMPT } from "../installPrompt.ts";
import { ArrowIcon, CheckIcon, CopyIcon, SpinnerIcon } from "./icons.tsx";
import { TruncatedKey } from "./TruncatedKey.tsx";

// Multi-step dialog opened from the dashboard's "Deploy your code" todo.
// Mirrors the playground's AgentStep + DeployStep:
//   1. install — show a copyable agent prompt with a fresh API key baked in
//   2. deploy  — tell the user to push the code, poll for first telemetry
//
// The dialog mints a fresh "Setup install" API key on first mount so the
// prompt is self-contained. The key is write-only so this is fine to surface
// directly inline.

type Step = "install" | "deploy";

function hasEvents(stats: Stats | undefined): boolean {
  if (!stats) return false;
  return stats.traces + stats.logs + stats.metrics > 0;
}

export function DeployDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("install");

  // Mint a fresh key on first render. The plaintext is only available right
  // after creation — re-opening the modal mints a new key. We keep the
  // mutation's `data` so we can recover the plaintext during this session.
  const createKey = useCreateKey(projectId);
  // Ref guard so StrictMode's double-mount in dev (and any conditional remount
  // from a parent) can't double-mint. Same defense the OnboardingWizard uses.
  const minted = useRef(false);
  useEffect(() => {
    if (minted.current) return;
    minted.current = true;
    createKey.mutate("Setup install");
  }, [createKey.mutate]);

  // Poll stats while the dialog is open so we can detect first events on the
  // deploy step without the user reloading.
  const stats = useStats(projectId, { poll: true });
  const eventsArrived = hasEvents(stats.data);

  // Esc + body scroll lock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      // biome-ignore lint/a11y/useSemanticElements: <dialog> would require .showModal() lifecycle wiring; conditional render with role="dialog" is intentional.
      role="dialog"
      aria-modal="true"
      aria-labelledby="deploy-dialog-title"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default border-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-[640px] overflow-hidden rounded-[14px] border border-border-strong bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-3 border-b border-border px-[22px] py-[18px]">
          <Stepper step={step} />
          <button
            type="button"
            onClick={onClose}
            className="ml-auto -mr-1 grid h-7 w-7 place-items-center text-muted transition-colors hover:text-fg"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m3 3 6 6m0-6-6 6" />
            </svg>
          </button>
        </div>

        {step === "install" ? (
          <InstallStep
            apiKey={createKey.data?.plaintext ?? null}
            minting={createKey.isPending && !createKey.data}
            error={createKey.error ? String(createKey.error) : null}
            onSkip={onClose}
            onNext={() => setStep("deploy")}
          />
        ) : (
          <DeployStep
            eventsArrived={eventsArrived}
            onBack={() => setStep("install")}
            onDone={onClose}
          />
        )}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2">
      <Pip active={step === "install"} done={step === "deploy"} n={1} label="Install" />
      <span className="h-px w-6 bg-border" />
      <Pip active={step === "deploy"} done={false} n={2} label="Deploy" />
    </div>
  );
}

function Pip({
  active,
  done,
  n,
  label,
}: {
  active: boolean;
  done: boolean;
  n: number;
  label: string;
}) {
  const ring = done
    ? "bg-accent text-accent-ink"
    : active
      ? "border border-accent text-accent"
      : "border border-border text-subtle";
  return (
    <div className="flex items-center gap-2">
      <span
        className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold tabular-nums ${ring}`}
      >
        {done ? <CheckIcon size={10} /> : n}
      </span>
      <span
        className={`text-[12px] font-medium ${active ? "text-fg" : done ? "text-muted" : "text-subtle"}`}
      >
        {label}
      </span>
    </div>
  );
}

function InstallStep({
  apiKey,
  minting,
  error,
  onSkip,
  onNext,
}: {
  apiKey: string | null;
  minting: boolean;
  error: string | null;
  onSkip: () => void;
  onNext: () => void;
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
    <>
      <div className="px-[22px] pb-2 pt-5">
        <h2
          id="deploy-dialog-title"
          className="text-[20px] font-semibold tracking-[-0.02em] text-fg"
        >
          Install Superlog
        </h2>
        <p className="mt-1.5 max-w-[520px] text-[13px] leading-[1.55] text-muted">
          Paste this prompt in Cursor, Claude Code, Codex, or any agent. It runs the install skill
          end-to-end — adds the SDK, instruments your code, opens a PR.
        </p>
      </div>

      <div className="px-[22px] pb-[18px] pt-3">
        <div className="overflow-hidden rounded-[10px] border border-border bg-[#0a0a0c]">
          <div className="flex items-center justify-between gap-2.5 border-b border-border px-[18px] py-[8px]">
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
                  Use API key <TruncatedKey value={apiKey} className="font-mono text-[12px] text-[#8C98F0]" />.
                </p>
              ) : null}
            </div>
            <p className="mt-2.5 text-[11.5px] leading-[1.5] text-subtle">
              The key is write-only — it can only ingest events, not read them — and you can rotate
              it any time from settings. Safe to drop straight into your agent.
            </p>
          </div>
        </div>
      </div>

      <Footer
        leftLabel="Skip for now"
        onLeft={onSkip}
        right={
          <Btn
            variant="primary"
            size="md"
            onClick={onNext}
            className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
          >
            The agent is done
            <ArrowIcon />
          </Btn>
        }
      />
    </>
  );
}

function DeployStep({
  eventsArrived,
  onBack,
  onDone,
}: {
  eventsArrived: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  return (
    <>
      <div className="px-[22px] pb-2 pt-5">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Deploy the code</h2>
        <p className="mt-1.5 text-[13px] leading-[1.55] text-muted">
          Push the code to the production / sandbox environment as you do, or run it locally.
        </p>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted">
          We'll tell you when we start receiving events from your code.
        </p>
      </div>

      <div className="px-[22px] pb-[18px] pt-3">
        {eventsArrived ? (
          <div className="flex items-center gap-2.5 rounded-[10px] border border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)] px-4 py-3">
            <span className="text-success">
              <CheckIcon size={14} />
            </span>
            <div className="flex-1 text-[12.5px] text-fg">
              First event received. <span className="text-muted">You're flowing.</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-border-strong px-4 py-3">
            <span className="text-[#8C98F0]">
              <SpinnerIcon size={14} />
            </span>
            <div className="flex-1 text-[12.5px] text-muted">Waiting for your first event…</div>
          </div>
        )}
      </div>

      <Footer
        leftLabel="Back"
        onLeft={onBack}
        right={
          <Btn
            variant="primary"
            size="md"
            onClick={onDone}
            className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
          >
            {eventsArrived ? "Done" : "I've deployed"}
            <ArrowIcon />
          </Btn>
        }
      />
    </>
  );
}

function Footer({
  leftLabel,
  onLeft,
  right,
}: {
  leftLabel: string;
  onLeft: () => void;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-[22px] py-[14px]">
      <button
        type="button"
        onClick={onLeft}
        className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
      >
        {leftLabel}
      </button>
      {right}
    </div>
  );
}
