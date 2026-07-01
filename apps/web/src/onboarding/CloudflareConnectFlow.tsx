import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useCloudflareInstallation, useStartCloudflareInstall } from "../api.ts";
import { Btn } from "../design/ui.tsx";
import {
  type CloudflarePhase,
  canContinueCloudflare,
  cloudflareOutcomeMessage,
  cloudflarePhase,
  cloudflareStatusText,
  parseCloudflareOutcome,
} from "./cloudflareConnectModel.ts";
import { CheckIcon, ExternalLinkIcon, SpinnerIcon } from "./icons.tsx";
import {
  ExploreDemoLink,
  SOFT_LINE,
  STRONG_LINE,
  StepFooter,
  StepHeader,
} from "./wizardChrome.tsx";

// Open the Cloudflare consent screen in a new tab, falling back to a same-tab
// navigation if the popup was blocked. Same opener-severing trick as the AWS
// launch helper so we keep the security guarantee without window.open returning
// null (which would make every launch also navigate the current tab).
function openConsent(url: string) {
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
  } else {
    window.location.assign(url);
  }
}

export function CloudflareConnectFlow({
  projectId,
  eventsArrived,
  onBack,
  onDone,
  onExploreDemo,
}: {
  projectId: string;
  // Whether the real project has ingested telemetry yet (from the parent's
  // `me.project.hasIngested`). NOT derived from the stats endpoint, which is
  // demo-overlaid for un-ingested projects and would falsely report events.
  eventsArrived: boolean;
  onBack: () => void;
  onDone: () => void;
  onExploreDemo?: () => void;
}) {
  // Whether we've opened the consent screen this session. Drives the transition
  // from the "start" call-to-action to the "connecting" waiting state while the
  // installation poll (every 15s) catches the round-trip landing.
  const [launched, setLaunched] = useState(false);
  // A failure surfaced by the OAuth callback redirect (`?cloudflare=denied|error`).
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  const install = useCloudflareInstallation(projectId);
  const start = useStartCloudflareInstall(projectId);

  // The callback redirects back to the app with `?cloudflare=...`. When the
  // consent was opened in the same tab (popup blocked), a denial/error lands
  // here — surface it and drop back out of the waiting state instead of spinning
  // forever. Strip the param so a refresh doesn't re-trigger it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const outcome = parseCloudflareOutcome(searchParams.get("cloudflare"));
    if (!outcome) return;
    if (outcome === "denied" || outcome === "error") {
      setLaunched(false);
      setOutcomeError(cloudflareOutcomeMessage(outcome));
    }
    const next = new URLSearchParams(searchParams);
    next.delete("cloudflare");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const installed = install.data?.installed === true;
  const phase = cloudflarePhase({ installed, launched });

  const connect = () => {
    if (start.isPending) return;
    setOutcomeError(null);
    start.mutate(undefined, {
      onSuccess: ({ url }) => {
        setLaunched(true);
        openConsent(url);
      },
    });
  };

  const header = headerForPhase(phase);

  return (
    <>
      <StepHeader title={header.title} sub={header.sub} />

      {phase === "start" && (
        <StartPanel
          onConnect={connect}
          pending={start.isPending}
          error={outcomeError ?? (start.error ? String(start.error) : null)}
        />
      )}

      {phase === "connecting" && (
        <ConnectingPanel
          statusText={cloudflareStatusText(phase, eventsArrived)}
          onReopen={connect}
          reopening={start.isPending}
        />
      )}

      {phase === "connected" && install.data?.installed && (
        <ConnectedPanel
          accountName={install.data.accountName}
          accountId={install.data.accountId}
          destinations={install.data.destinations}
          eventsArrived={eventsArrived}
        />
      )}

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={canContinueCloudflare(phase) ? "Continue" : "Waiting for Cloudflare…"}
        nextDisabled={!canContinueCloudflare(phase)}
      />
      {!canContinueCloudflare(phase) && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}

function headerForPhase(phase: CloudflarePhase): { title: string; sub: string } {
  switch (phase) {
    case "start":
      return {
        title: "Connect Cloudflare",
        sub: "Authorize Cloudflare once. We set up Workers Observability telemetry destinations that stream your Workers traces, logs, and metrics into Superlog — no agent, no code changes.",
      };
    case "connecting":
      return {
        title: "Finish in Cloudflare",
        sub: "Approve access in the Cloudflare tab we opened. Once you do, we create the destinations automatically — keep this tab open.",
      };
    default:
      return {
        title: "You're connected",
        sub: "Workers Observability destinations are set up. Telemetry will appear as your Workers run — discovery keeps working in the background.",
      };
  }
}

function StartPanel({
  onConnect,
  pending,
  error,
}: {
  onConnect: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div className={`border-b px-[22px] py-[18px] ${SOFT_LINE}`}>
        <p className="m-0 text-[13px] leading-[1.55] text-muted">
          We never ask for an API token. Cloudflare's OAuth grants a scoped, revocable token that we
          use only to create and manage telemetry destinations — you can disconnect any time from
          settings.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-[22px] py-[16px]">
        <span className="text-[12.5px] text-muted">
          Opens the Cloudflare consent screen in a new tab.
        </span>
        <Btn
          variant="primary"
          size="md"
          onClick={onConnect}
          loading={pending}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {pending ? "Preparing…" : "Connect Cloudflare account"}
          {!pending && <ExternalLinkIcon size={13} />}
        </Btn>
      </div>
      {error && (
        <div className={`border-t px-[22px] py-[12px] ${SOFT_LINE}`}>
          <p className="m-0 text-[12.5px] text-danger">{error}</p>
        </div>
      )}
    </div>
  );
}

function ConnectingPanel({
  statusText,
  onReopen,
  reopening,
}: {
  statusText: string;
  onReopen: () => void;
  reopening: boolean;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div
        className={`flex items-center gap-2.5 border-b px-[18px] py-[12px] ${SOFT_LINE} text-[12px]`}
      >
        <span className="text-[#8C98F0]">
          <SpinnerIcon size={13} />
        </span>
        <span className="text-muted">{statusText}</span>
      </div>
      <div className="px-[22px] py-[18px]">
        <ol className="m-0 list-decimal space-y-1.5 pl-4 text-[13px] leading-[1.5] text-muted">
          <li>Review the access request in the Cloudflare tab and approve it.</li>
          <li>We create the Workers Observability destinations automatically.</li>
          <li>This panel updates on its own once the connection lands.</li>
        </ol>
        <button
          type="button"
          onClick={onReopen}
          disabled={reopening}
          className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8C98F0] transition-colors hover:text-fg disabled:opacity-50"
        >
          <ExternalLinkIcon size={13} /> Reopen Cloudflare
        </button>
      </div>
    </div>
  );
}

function ConnectedPanel({
  accountName,
  accountId,
  destinations,
  eventsArrived,
}: {
  accountName: string | null;
  accountId: string;
  destinations: Record<string, string>;
  eventsArrived: boolean;
}) {
  const signals = Object.keys(destinations);
  return (
    <div className="flex flex-col gap-4">
      <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
        <div className={`border-b px-[18px] py-[10px] ${SOFT_LINE}`}>
          <span className="font-mono text-[12px] text-muted">
            {accountName ?? `Account ${accountId}`}
          </span>
        </div>
        <div className="divide-y divide-[rgba(255,255,255,0.07)]">
          {signals.length === 0 ? (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
              Setting up destinations…
            </div>
          ) : (
            signals.map((signal) => (
              <div key={signal} className="flex items-center gap-3 px-[18px] py-[13px]">
                <span className="text-success">
                  <CheckIcon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium capitalize text-fg">{signal}</span>
                  <span className="block text-[12px] text-muted">
                    Workers Observability destination created
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {eventsArrived ? (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)] px-4 py-3">
          <span className="text-success">
            <CheckIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] text-fg">
            First events received. <span className="text-muted">You're flowing.</span>
          </div>
        </div>
      ) : (
        <div
          className={`flex items-center gap-2.5 rounded-[10px] border border-dashed px-4 py-3 ${STRONG_LINE}`}
        >
          <span className="text-[#8C98F0]">
            <SpinnerIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] text-muted">
            Destinations are live. First events will appear as your Workers run.
          </div>
        </div>
      )}
    </div>
  );
}
