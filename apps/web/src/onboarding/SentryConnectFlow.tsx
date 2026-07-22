import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useImportOpenSentryIssues, useSentryInstallation, useStartSentryInstall } from "../api.ts";
import { Btn } from "../design/ui.tsx";
import { SentryProjectPicker } from "../sentry/SentryProjectPicker.tsx";
import { CheckIcon, ExternalLinkIcon, SpinnerIcon } from "./icons.tsx";
import { ExploreDemoLink, SOFT_LINE, StepFooter, StepHeader } from "./wizardChrome.tsx";

export function SentryConnectFlow({
  projectId,
  issuesArrived,
  onBack,
  onDone,
  onExploreDemo,
}: {
  projectId: string;
  issuesArrived: boolean;
  onBack: () => void;
  onDone: () => void;
  onExploreDemo?: () => void;
}) {
  const installation = useSentryInstallation(projectId);
  const start = useStartSentryInstall(projectId, "onboarding");
  const issueImport = useImportOpenSentryIssues(projectId);
  const installed = installation.data?.installed === true ? installation.data : null;
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const authorizationId = searchParams.get("sentryAuthorization");
  const authorizationProjectId = searchParams.get("sentryProjectId") ?? projectId;
  const choosingProject = searchParams.get("sentry") === "choose-project" && !!authorizationId;
  const importAttempted = useRef(false);

  useEffect(() => {
    const outcome = searchParams.get("sentry");
    if (!outcome) return;
    if (outcome === "choose-project") return;
    if (outcome === "denied") setOutcomeError("Sentry authorization was cancelled.");
    if (outcome === "error") {
      setOutcomeError("Sentry connected incompletely. Reconnect to retry the issue import.");
    }
    const next = new URLSearchParams(searchParams);
    next.delete("sentry");
    next.delete("sentryAuthorization");
    next.delete("sentryProjectId");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!installed || issuesArrived || importAttempted.current) return;
    importAttempted.current = true;
    issueImport.mutate();
  }, [installed, issuesArrived, issueImport.mutate]);

  const connect = async () => {
    if (start.isPending) return;
    setOutcomeError(null);
    try {
      const { url } = await start.mutateAsync();
      window.location.assign(url);
    } catch {
      // The mutation renders its own error below.
    }
  };

  return (
    <>
      <StepHeader
        title={installed ? "Sentry is connected" : "Connect Sentry"}
        sub={
          installed
            ? issuesArrived
              ? "We imported every currently open issue and will keep receiving new and regressed errors in near real time."
              : "We're importing open issues now and will keep receiving new and regressed errors in near real time."
            : "Authorize the Sentry Cloud app. We import every open issue immediately, then start investigations as new or regressed errors arrive."
        }
      />

      <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
        {installed && !choosingProject ? (
          <>
            <div className={`flex items-center gap-2.5 border-b px-[18px] py-[12px] ${SOFT_LINE}`}>
              <span className="text-success">
                <CheckIcon size={14} />
              </span>
              <span className="font-mono text-[12px] text-muted">
                {installed.organizationSlug}/{installed.projectSlug}
              </span>
            </div>
            <div className="flex items-start gap-3 px-[22px] py-[18px]">
              <span className={issuesArrived ? "text-success" : "text-[#8C98F0]"}>
                {issuesArrived ? <CheckIcon size={15} /> : <SpinnerIcon size={15} />}
              </span>
              <div>
                <p className="m-0 text-[13px] font-medium text-fg">
                  {issuesArrived
                    ? "Sentry errors received"
                    : issueImport.isPending
                      ? "Importing open Sentry issues"
                      : "Waiting for the first open error"}
                </p>
                <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-muted">
                  {issuesArrived
                    ? "The imported errors are queued for investigation."
                    : issueImport.isPending
                      ? "You can keep using this page while the import runs in the background."
                      : "This project has no open issues yet. You can leave this tab open; the first new or regressed issue will complete onboarding automatically."}
                </p>
              </div>
            </div>
            <div className={`border-t px-[22px] py-[12px] ${SOFT_LINE}`}>
              <div className="flex items-center gap-4">
                {issueImport.error && (
                  <button
                    type="button"
                    onClick={() => issueImport.mutate()}
                    disabled={issueImport.isPending}
                    className="text-[12.5px] font-medium text-[#8C98F0] transition-colors hover:text-fg disabled:opacity-50"
                  >
                    Retry issue import
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={start.isPending}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8C98F0] transition-colors hover:text-fg disabled:opacity-50"
                >
                  <ExternalLinkIcon size={13} />
                  {start.isPending ? "Preparing…" : "Reconnect Sentry"}
                </button>
              </div>
            </div>
          </>
        ) : choosingProject && authorizationId ? (
          <div className="px-[22px] py-[18px]">
            <SentryProjectPicker
              projectId={authorizationProjectId}
              authorizationId={authorizationId}
              onConnected={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("sentry");
                next.delete("sentryAuthorization");
                next.delete("sentryProjectId");
                setSearchParams(next, { replace: true });
              }}
              onRestart={async () => {
                const { url } = await start.mutateAsync();
                window.location.assign(url);
              }}
            />
          </div>
        ) : (
          <div className="space-y-4 px-[22px] py-[18px]">
            <p className="m-0 text-[12.5px] leading-[1.5] text-muted">
              Choose the organization in Sentry. If it has one project, we connect it automatically;
              otherwise you will choose from a project list here. Self-hosted Sentry is not
              supported yet.
            </p>
            <Btn
              variant="primary"
              size="md"
              onClick={() => void connect()}
              loading={start.isPending}
              disabled={start.isPending}
              className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
            >
              {start.isPending ? "Preparing…" : "Connect Sentry"}
              {!start.isPending && <ExternalLinkIcon size={13} />}
            </Btn>
          </div>
        )}
        {(outcomeError || start.error || issueImport.error) && (
          <div className={`border-t px-[22px] py-[12px] ${SOFT_LINE}`}>
            <p className="m-0 text-[12.5px] text-danger">
              {outcomeError ?? String(start.error ?? issueImport.error)}
            </p>
          </div>
        )}
      </div>

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={issuesArrived ? "Continue" : "Waiting for Sentry…"}
        nextDisabled={!issuesArrived}
      />
      {!issuesArrived && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}
