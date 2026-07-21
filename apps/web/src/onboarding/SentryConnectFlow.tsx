import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useImportOpenSentryIssues, useSentryInstallation, useStartSentryInstall } from "../api.ts";
import { Btn } from "../design/ui.tsx";
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
  const [projectSlug, setProjectSlug] = useState("");
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const importAttempted = useRef(false);

  useEffect(() => {
    if (installed?.projectSlug) setProjectSlug(installed.projectSlug);
  }, [installed?.projectSlug]);

  useEffect(() => {
    const outcome = searchParams.get("sentry");
    if (!outcome) return;
    if (outcome === "denied") setOutcomeError("Sentry authorization was cancelled.");
    if (outcome === "error") {
      setOutcomeError("Sentry connected incompletely. Reconnect to retry the issue import.");
    }
    const next = new URLSearchParams(searchParams);
    next.delete("sentry");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!installed || issuesArrived || importAttempted.current) return;
    importAttempted.current = true;
    issueImport.mutate();
  }, [installed, issuesArrived, issueImport.mutate]);

  const connect = async () => {
    const slug = projectSlug.trim().toLowerCase();
    if (!slug || start.isPending) return;
    setOutcomeError(null);
    try {
      const { url } = await start.mutateAsync(slug);
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
        {installed ? (
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
        ) : (
          <div className="space-y-4 px-[22px] py-[18px]">
            <div>
              <label
                htmlFor="onboarding-sentry-project"
                className="block text-[11.5px] uppercase tracking-[0.08em] text-subtle"
              >
                Sentry project slug
              </label>
              <input
                id="onboarding-sentry-project"
                value={projectSlug}
                onChange={(event) => setProjectSlug(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
                placeholder="storefront"
                autoCapitalize="none"
                spellCheck={false}
                className="mt-2 block w-full rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#0f1014] px-3 py-2 text-[14px] text-fg outline-none transition-colors focus:border-[#8C98F0]"
              />
              <p className="m-0 mt-2 text-[11.5px] text-subtle">
                You choose the organization in Sentry. Self-hosted Sentry is not supported yet.
              </p>
            </div>
            <Btn
              variant="primary"
              size="md"
              onClick={() => void connect()}
              loading={start.isPending}
              disabled={!projectSlug.trim() || start.isPending}
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
