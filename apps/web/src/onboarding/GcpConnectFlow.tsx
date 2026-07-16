import { useState } from "react";
import { useGcpConnection, useStartGcpConnect } from "../api.ts";
import { Btn } from "../design/ui.tsx";
import { type GcpPhase, canContinueGcp, gcpPhase, gcpStatusText } from "./gcpConnectModel.ts";
import { CheckIcon, ExternalLinkIcon, SpinnerIcon } from "./icons.tsx";
import {
  ExploreDemoLink,
  SOFT_LINE,
  STRONG_LINE,
  StepFooter,
  StepHeader,
} from "./wizardChrome.tsx";

// Open the Google Cloud consent screen in a new tab, severing the opener. The
// new tab lets this onboarding tab keep polling the connection endpoint while
// the user authorizes and picks a project on the standalone /connect/gcp page.
//
// We deliberately do NOT fall back to a same-tab navigation when the popup is
// blocked: unlike the other OAuth callbacks, which carry their outcome back to
// `/`, the /connect/gcp result page returns to `/settings`, so a same-tab
// round-trip would drop the user out of onboarding. When the popup is blocked
// the connecting panel exposes a manual open link (a plain anchor, which isn't
// popup-blocked) that keeps this tab and its polling alive.
function openConsent(url: string) {
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (win) win.opener = null;
}

export function GcpConnectFlow({
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
  // from "start" to the "connecting" waiting state while the connection poll
  // catches the OAuth + project-selection round-trip landing.
  const [launched, setLaunched] = useState(false);
  // The most recent consent URL, kept so the connecting panel can offer a
  // manual open link (an anchor, which isn't subject to popup blocking) without
  // re-minting a fresh authorization.
  const [consentUrl, setConsentUrl] = useState<string | null>(null);

  const connection = useGcpConnection(projectId);
  const start = useStartGcpConnect(projectId);

  const row = connection.data && "status" in connection.data ? connection.data : null;
  const phase = gcpPhase({ status: row?.status ?? null, launched });

  const connect = async () => {
    if (start.isPending) return;
    try {
      const { url } = await start.mutateAsync();
      setConsentUrl(url);
      setLaunched(true);
      openConsent(url);
    } catch {
      // The mutation error surfaces via start.error below.
    }
  };

  const header = headerForPhase(phase);

  return (
    <>
      <StepHeader title={header.title} sub={header.sub} />

      {phase === "start" && (
        <StartPanel
          onConnect={connect}
          pending={start.isPending}
          error={start.error ? String(start.error) : null}
        />
      )}

      {phase === "connecting" && (
        <ConnectingPanel statusText={gcpStatusText(phase, eventsArrived)} consentUrl={consentUrl} />
      )}

      {phase === "failed" && (
        <FailedPanel
          lastError={row?.lastError ?? null}
          onReconnect={connect}
          reconnecting={start.isPending}
        />
      )}

      {phase === "connected" && row && (
        <ConnectedPanel gcpProjectId={row.gcpProjectId} eventsArrived={eventsArrived} />
      )}

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={canContinueGcp(phase) ? "Continue" : "Waiting for Google Cloud…"}
        nextDisabled={!canContinueGcp(phase)}
      />
      {!canContinueGcp(phase) && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}

function headerForPhase(phase: GcpPhase): { title: string; sub: string } {
  switch (phase) {
    case "start":
      return {
        title: "Connect Google Cloud",
        sub: "Authorize Google Cloud once and pick a project. We route Cloud Logging and read a bounded set of Cloud Monitoring metrics — no Terraform, no service-account key.",
      };
    case "connecting":
      return {
        title: "Finish in Google Cloud",
        sub: "Approve the access request in the Google tab we opened, then choose the project you want to share — keep this tab open.",
      };
    case "failed":
      return {
        title: "Connection didn't finish",
        sub: "Something went wrong provisioning the connection. Reconnect to try again.",
      };
    default:
      return {
        title: "You're connected",
        sub: "We're routing Cloud Logging and reading bounded Cloud Monitoring metrics. First events typically appear within a minute.",
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
          We never ask for a service-account key. Google's OAuth grants a scoped token; we create a
          Cloud Logging route and read a curated set of Cloud Monitoring metrics with a hard monthly
          series ceiling. Superlog owns and pays for Pub/Sub and Monitoring API reads — your
          incremental GCP cost is $0. Disconnect any time from settings.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-[22px] py-[16px]">
        <span className="text-[12.5px] text-muted">
          Opens the Google Cloud consent screen in a new tab.
        </span>
        <Btn
          variant="primary"
          size="md"
          onClick={onConnect}
          loading={pending}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {pending ? "Preparing…" : "Connect Google Cloud"}
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
  consentUrl,
}: {
  statusText: string;
  consentUrl: string | null;
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
          <li>Approve the access request in the Google tab.</li>
          <li>Pick the Google Cloud project you want to share.</li>
          <li>This panel updates on its own once the connection lands.</li>
        </ol>
        {consentUrl && (
          <a
            href={consentUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8C98F0] transition-colors hover:text-fg"
          >
            <ExternalLinkIcon size={13} /> Didn't see a tab? Reopen Google Cloud
          </a>
        )}
      </div>
    </div>
  );
}

function FailedPanel({
  lastError,
  onReconnect,
  reconnecting,
}: {
  lastError: string | null;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div className={`border-b px-[22px] py-[18px] ${SOFT_LINE}`}>
        <p className="m-0 text-[13px] leading-[1.55] text-danger">
          {lastError ?? "We couldn't finish connecting Google Cloud."}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-[22px] py-[16px]">
        <span className="text-[12.5px] text-muted">Nothing was changed on your account.</span>
        <Btn
          variant="primary"
          size="md"
          onClick={onReconnect}
          loading={reconnecting}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {reconnecting ? "Preparing…" : "Reconnect Google Cloud"}
          {!reconnecting && <ExternalLinkIcon size={13} />}
        </Btn>
      </div>
    </div>
  );
}

function ConnectedPanel({
  gcpProjectId,
  eventsArrived,
}: {
  gcpProjectId: string;
  eventsArrived: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
        <div className={`border-b px-[18px] py-[10px] ${SOFT_LINE}`}>
          <span className="font-mono text-[12px] text-muted">Google Cloud project shared</span>
        </div>
        <div className="flex items-center gap-3 px-[18px] py-[13px]">
          <span className="text-success">
            <CheckIcon size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-fg">{gcpProjectId}</span>
            <span className="block text-[12px] text-muted">Cloud Logging + bounded metrics</span>
          </span>
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
            The connection is live. First logs and metrics typically appear within a minute.
          </div>
        </div>
      )}
    </div>
  );
}
