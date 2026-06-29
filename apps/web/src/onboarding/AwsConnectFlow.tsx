import { useState } from "react";
import {
  type StackComponent,
  useCloudConnections,
  useCloudResources,
  useCloudStackHealth,
  useCreateCloudConnection,
  useSyncCloudConnection,
  useVerifyCloudConnection,
} from "../api.ts";
import { AWS_REGIONS, DEFAULT_AWS_REGION } from "../awsRegions.ts";
import { Btn } from "../design/ui.tsx";
import {
  activeConnection,
  awsPhase,
  awsStreamFlowing,
  canContinueAws,
  connectionStatusText,
  isValidRegion,
  stackComponentTone,
} from "./awsConnectModel.ts";
import { CheckIcon, ExternalLinkIcon, SpinnerIcon } from "./icons.tsx";
import {
  ExploreDemoLink,
  SOFT_LINE,
  STRONG_LINE,
  StepFooter,
  StepHeader,
} from "./wizardChrome.tsx";

// Open the CloudFormation console in a new tab, falling back to a same-tab
// navigation if the popup was blocked. We can't pass "noopener" to window.open
// because that forces it to return null, which would make every launch also
// navigate the current tab via the fallback. Instead open normally, then sever
// the opener reference ourselves for the same security guarantee.
function openLaunch(url: string) {
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
  } else {
    window.location.assign(url);
  }
}

const TONE_DOT: Record<ReturnType<typeof stackComponentTone>, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-subtle",
};

function HealthRow({ component }: { component: StackComponent }) {
  const tone = stackComponentTone(component.state);
  return (
    <div className="flex items-center gap-3 px-[18px] py-[13px]">
      <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-fg">{component.label}</span>
        <span className="block text-[12px] text-muted">{component.detail}</span>
      </span>
      {component.state === "working" && (
        <span className="text-success">
          <CheckIcon size={14} />
        </span>
      )}
      {component.state === "pending" && (
        <span className="text-warning">
          <SpinnerIcon size={13} />
        </span>
      )}
    </div>
  );
}

export function AwsConnectFlow({
  projectId,
  onBack,
  onDone,
  onExploreDemo,
}: {
  projectId: string;
  onBack: () => void;
  onDone: () => void;
  onExploreDemo?: () => void;
}) {
  const [region, setRegion] = useState<string>(DEFAULT_AWS_REGION);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [roleArn, setRoleArn] = useState("");

  const connections = useCloudConnections(projectId);
  const create = useCreateCloudConnection(projectId);
  const verify = useVerifyCloudConnection(projectId);
  const sync = useSyncCloudConnection(projectId);
  const resources = useCloudResources(projectId);

  const connection = activeConnection(connections.data);
  // Poll stack health once the role is verified so we can tell when *this*
  // connection's CloudWatch streams actually deliver — distinct from any
  // pre-existing project telemetry.
  const stackHealth = useCloudStackHealth(
    projectId,
    connection?.id,
    connection?.status === "connected",
  );
  const streamFlowing = awsStreamFlowing(stackHealth.data?.components);
  const phase = awsPhase({ connection, streamFlowing });

  const connect = () => {
    if (!isValidRegion(region) || create.isPending) return;
    create.mutate(
      { region },
      {
        onSuccess: (data) => {
          setLaunchUrl(data.launchUrl);
          openLaunch(data.launchUrl);
        },
      },
    );
  };

  const submitVerify = () => {
    if (!connection || !roleArn.trim() || verify.isPending) return;
    verify.mutate({ id: connection.id, scrapeRoleArn: roleArn.trim() });
  };

  const header = headerForPhase(phase);

  return (
    <>
      <StepHeader title={header.title} sub={header.sub} />

      {phase === "start" && (
        <StartPanel
          region={region}
          onRegion={setRegion}
          onConnect={connect}
          pending={create.isPending}
          error={create.error ? String(create.error) : null}
        />
      )}

      {phase === "launching" && connection && (
        <LaunchingPanel
          statusText={connectionStatusText(connection.status, connection.lastError)}
          failed={connection.status === "failed" || connection.status === "account_mismatch"}
          launchUrl={launchUrl}
          showPaste={showPaste}
          onTogglePaste={() => setShowPaste((v) => !v)}
          roleArn={roleArn}
          onRoleArn={setRoleArn}
          onVerify={submitVerify}
          verifying={verify.isPending}
          verifyError={verify.error ? String(verify.error) : null}
        />
      )}

      {(phase === "connected" || phase === "flowing") && connection && (
        <ConnectedPanel
          components={stackHealth.data?.components ?? []}
          streamFlowing={streamFlowing}
          region={connection.region}
          accountId={connection.accountId}
          resourceCount={resources.data?.length ?? 0}
          onRescan={() => sync.mutate(connection.id)}
          rescanning={sync.isPending}
        />
      )}

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={canContinueAws(phase) ? "Continue" : "Waiting for data…"}
        nextDisabled={!canContinueAws(phase)}
      />
      {!canContinueAws(phase) && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}

function headerForPhase(phase: ReturnType<typeof awsPhase>): {
  title: string;
  sub: string;
} {
  switch (phase) {
    case "start":
      return {
        title: "Connect Amazon Web Services",
        sub: "Launch one CloudFormation stack. It creates a read-only role and streams CloudWatch logs and metrics into Superlog — no agent, no code changes.",
      };
    case "launching":
      return {
        title: "Finish in CloudFormation",
        sub: "Deploy the stack we opened in AWS. Once it reports back we'll verify the role automatically — keep this tab open.",
      };
    case "connected":
      return {
        title: "Almost there",
        sub: "Your account is connected. We're waiting for the first logs and metrics to stream in from CloudWatch.",
      };
    default:
      return {
        title: "You're flowing",
        sub: "Telemetry from AWS is arriving. You can head to your dashboard now — discovery keeps running in the background.",
      };
  }
}

function StartPanel({
  region,
  onRegion,
  onConnect,
  pending,
  error,
}: {
  region: string;
  onRegion: (r: string) => void;
  onConnect: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div className={`border-b px-[22px] py-[18px] ${SOFT_LINE}`}>
        <label htmlFor="aws-region" className="block text-[12.5px] font-medium text-muted">
          Region
        </label>
        <div className="relative mt-2 max-w-[260px]">
          <select
            id="aws-region"
            value={region}
            onChange={(e) => onRegion(e.target.value)}
            disabled={pending}
            className="h-9 w-full appearance-none rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#0f1014] pl-3 pr-8 font-mono text-[13px] text-fg outline-none transition-colors focus:border-[#8C98F0] disabled:opacity-60"
          >
            {AWS_REGIONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
        <p className="mt-2.5 text-[11.5px] leading-[1.5] text-subtle">
          We never store long-lived AWS credentials — the stack grants a role Superlog assumes with
          an external ID, scoped to read-only telemetry.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-[22px] py-[16px]">
        <span className="text-[12.5px] text-muted">
          Opens the AWS console in a new tab to review and deploy.
        </span>
        <Btn
          variant="primary"
          size="md"
          onClick={onConnect}
          loading={pending}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {pending ? "Preparing…" : "Connect AWS account"}
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

function LaunchingPanel({
  statusText,
  failed,
  launchUrl,
  showPaste,
  onTogglePaste,
  roleArn,
  onRoleArn,
  onVerify,
  verifying,
  verifyError,
}: {
  statusText: string;
  failed: boolean;
  launchUrl: string | null;
  showPaste: boolean;
  onTogglePaste: () => void;
  roleArn: string;
  onRoleArn: (v: string) => void;
  onVerify: () => void;
  verifying: boolean;
  verifyError: string | null;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div
        className={`flex items-center gap-2.5 border-b px-[18px] py-[12px] ${SOFT_LINE} text-[12px]`}
      >
        <span className={failed ? "text-danger" : "text-[#8C98F0]"}>
          {failed ? "!" : <SpinnerIcon size={13} />}
        </span>
        <span className={failed ? "text-danger" : "text-muted"}>{statusText}</span>
      </div>
      <div className="px-[22px] py-[18px]">
        <ol className="m-0 list-decimal space-y-1.5 pl-4 text-[13px] leading-[1.5] text-muted">
          <li>Review the stack in the AWS console and click Create.</li>
          <li>Wait for it to reach CREATE_COMPLETE (about a minute).</li>
          <li>We verify the role automatically — this panel updates on its own.</li>
        </ol>
        {launchUrl && (
          <button
            type="button"
            onClick={() => openLaunch(launchUrl)}
            className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8C98F0] transition-colors hover:text-fg"
          >
            <ExternalLinkIcon size={13} /> Reopen CloudFormation
          </button>
        )}
      </div>
      <div className={`border-t px-[22px] py-[14px] ${SOFT_LINE}`}>
        <button
          type="button"
          onClick={onTogglePaste}
          className="text-[12px] font-medium text-subtle transition-colors hover:text-muted"
        >
          {showPaste ? "Hide manual step" : "Stack won't report back? Paste the role ARN instead"}
        </button>
        {showPaste && (
          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              value={roleArn}
              onChange={(e) => onRoleArn(e.target.value)}
              placeholder="arn:aws:iam::123456789012:role/superlog-connect"
              className="h-9 min-w-0 flex-1 rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#0f1014] px-3 font-mono text-[12px] text-fg outline-none transition-colors focus:border-[#8C98F0]"
            />
            <Btn
              variant="secondary"
              size="md"
              onClick={onVerify}
              loading={verifying}
              disabled={!roleArn.trim()}
              className="!h-9 !rounded-[8px]"
            >
              Verify
            </Btn>
          </div>
        )}
        {verifyError && <p className="m-0 mt-2 text-[12px] text-danger">{verifyError}</p>}
      </div>
    </div>
  );
}

function ConnectedPanel({
  components,
  streamFlowing,
  region,
  accountId,
  resourceCount,
  onRescan,
  rescanning,
}: {
  components: StackComponent[];
  streamFlowing: boolean;
  region: string;
  accountId: string | null;
  resourceCount: number;
  onRescan: () => void;
  rescanning: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
        <div
          className={`flex items-center justify-between gap-2 border-b px-[18px] py-[10px] ${SOFT_LINE}`}
        >
          <span className="font-mono text-[12px] text-muted">
            {accountId ? `Account ${accountId}` : "AWS"} · {region}
          </span>
          <button
            type="button"
            onClick={onRescan}
            disabled={rescanning}
            className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            {rescanning ? <SpinnerIcon size={12} /> : null}
            {rescanning ? "Scanning…" : "Rescan resources"}
          </button>
        </div>
        <div className="divide-y divide-[rgba(255,255,255,0.07)]">
          {components.length === 0 ? (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
              Reading stack health…
            </div>
          ) : (
            components.map((c) => <HealthRow key={c.key} component={c} />)
          )}
        </div>
        {resourceCount > 0 && (
          <div className={`border-t px-[18px] py-[11px] text-[12px] text-muted ${SOFT_LINE}`}>
            Discovered <span className="font-medium text-fg">{resourceCount}</span> AWS resource
            {resourceCount === 1 ? "" : "s"} so far.
          </div>
        )}
      </div>

      {streamFlowing ? (
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
            Waiting for your first events from AWS…
          </div>
        </div>
      )}
    </div>
  );
}
