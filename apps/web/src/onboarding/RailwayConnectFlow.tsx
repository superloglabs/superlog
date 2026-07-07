import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRailwayInstallation, useStartRailwayInstall } from "../api.ts";
import { Btn } from "../design/ui.tsx";
import { CheckIcon, ExternalLinkIcon, SpinnerIcon } from "./icons.tsx";
import {
  type RailwayPhase,
  canContinueRailway,
  parseRailwayOutcome,
  railwayOutcomeMessage,
  railwayPhase,
  railwayStatusText,
} from "./railwayConnectModel.ts";
import {
  ExploreDemoLink,
  SOFT_LINE,
  STRONG_LINE,
  StepFooter,
  StepHeader,
} from "./wizardChrome.tsx";

// Open the Railway consent screen in a new tab, falling back to a same-tab
// navigation if the popup was blocked. Same opener-severing trick as the other
// connector launch helpers.
function openConsent(url: string) {
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
  } else {
    window.location.assign(url);
  }
}

export function RailwayConnectFlow({
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
  // Whether we've opened the consent screen this session. Drives the
  // transition from "start" to the "connecting" waiting state while the
  // installation poll catches the round-trip landing.
  const [launched, setLaunched] = useState(false);
  // A failure surfaced by the OAuth callback redirect (`?railway=denied|…`).
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  const install = useRailwayInstallation(projectId);
  const start = useStartRailwayInstall(projectId);

  // The callback redirects back to the app with `?railway=...`. When the
  // consent screen was opened in the same tab (popup blocked), a failure lands
  // here — surface it and drop out of the waiting state instead of spinning
  // forever. Strip the param so a refresh doesn't re-trigger it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const outcome = parseRailwayOutcome(searchParams.get("railway"));
    if (!outcome) return;
    if (outcome === "denied" || outcome === "error" || outcome === "no_projects") {
      setLaunched(false);
      setOutcomeError(railwayOutcomeMessage(outcome));
    }
    const next = new URLSearchParams(searchParams);
    next.delete("railway");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const installed = install.data?.installed === true;
  const phase = railwayPhase({ installed, launched });

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
          statusText={railwayStatusText(phase, eventsArrived)}
          onReopen={connect}
          reopening={start.isPending}
        />
      )}

      {phase === "connected" && install.data?.installed && (
        <ConnectedPanel
          grantedProjects={install.data.grantedProjects}
          eventsArrived={eventsArrived}
        />
      )}

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={canContinueRailway(phase) ? "Continue" : "Waiting for Railway…"}
        nextDisabled={!canContinueRailway(phase)}
      />
      {!canContinueRailway(phase) && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}

function headerForPhase(phase: RailwayPhase): { title: string; sub: string } {
  switch (phase) {
    case "start":
      return {
        title: "Connect Railway",
        sub: "Authorize Railway once and pick the projects to share. We pull your services' logs and infra metrics from Railway's API — no agent, no code changes.",
      };
    case "connecting":
      return {
        title: "Finish in Railway",
        sub: "Approve the access request in the Railway tab we opened, and select the projects you want to share — keep this tab open.",
      };
    default:
      return {
        title: "You're connected",
        sub: "We're pulling logs and metrics from your Railway projects. First events typically appear within a minute.",
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
          We never ask for an API token. Railway's OAuth grants a scoped, read-only token limited to
          the projects you select on the consent screen — you can disconnect any time from settings,
          or revoke the grant under Railway's Authorized Apps.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-[22px] py-[16px]">
        <span className="text-[12.5px] text-muted">
          Opens the Railway consent screen in a new tab.
        </span>
        <Btn
          variant="primary"
          size="md"
          onClick={onConnect}
          loading={pending}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {pending ? "Preparing…" : "Connect Railway account"}
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
          <li>Review the access request in the Railway tab.</li>
          <li>Select the Railway projects you want to share, then approve.</li>
          <li>This panel updates on its own once the connection lands.</li>
        </ol>
        <button
          type="button"
          onClick={onReopen}
          disabled={reopening}
          className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8C98F0] transition-colors hover:text-fg disabled:opacity-50"
        >
          <ExternalLinkIcon size={13} /> Reopen Railway
        </button>
      </div>
    </div>
  );
}

function ConnectedPanel({
  grantedProjects,
  eventsArrived,
}: {
  grantedProjects: Array<{ id: string; name: string; workspaceName: string | null }>;
  eventsArrived: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
        <div className={`border-b px-[18px] py-[10px] ${SOFT_LINE}`}>
          <span className="font-mono text-[12px] text-muted">
            {grantedProjects.length === 1
              ? "1 Railway project shared"
              : `${grantedProjects.length} Railway projects shared`}
          </span>
        </div>
        <div className="divide-y divide-[rgba(255,255,255,0.07)]">
          {grantedProjects.length === 0 ? (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
              Reading the granted projects…
            </div>
          ) : (
            grantedProjects.map((project) => (
              <div key={project.id} className="flex items-center gap-3 px-[18px] py-[13px]">
                <span className="text-success">
                  <CheckIcon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{project.name}</span>
                  <span className="block text-[12px] text-muted">
                    {project.workspaceName
                      ? `${project.workspaceName} — logs + metrics`
                      : "logs + metrics"}
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
            The pull is live. First logs and metrics typically appear within a minute.
          </div>
        </div>
      )}
    </div>
  );
}
