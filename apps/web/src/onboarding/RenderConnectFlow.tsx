import { useState } from "react";
import {
  type RenderOwner,
  useConnectRender,
  useRenderInstallation,
  useRenderOwners,
} from "../api.ts";
import { Btn } from "../design/ui.tsx";
import { CheckIcon, SpinnerIcon } from "./icons.tsx";
import {
  canContinueRender,
  renderErrorMessage,
  renderPhase,
  renderStatusText,
} from "./renderConnectModel.ts";
import {
  ExploreDemoLink,
  SOFT_LINE,
  STRONG_LINE,
  StepFooter,
  StepHeader,
} from "./wizardChrome.tsx";

// Render has no third-party OAuth, so this flow is a two-step form instead of
// a consent popup: paste an API key (validated server-side by listing the
// workspaces it can see), pick the workspace to share, connect. The key only
// lives in component state between the two calls.
export function RenderConnectFlow({
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
  const [apiKey, setApiKey] = useState("");
  const [owners, setOwners] = useState<RenderOwner[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);

  const install = useRenderInstallation(projectId);
  const validate = useRenderOwners(projectId);
  const connect = useConnectRender(projectId);

  const installed = install.data?.installed === true;
  const phase = renderPhase({ installed, ownersLoaded: owners !== null });

  const submitKey = () => {
    if (validate.isPending || !apiKey.trim()) return;
    validate.mutate(apiKey.trim(), {
      onSuccess: ({ owners }) => {
        setOwners(owners);
        // A single workspace needs no choice.
        setOwnerId(owners.length === 1 ? (owners[0]?.id ?? null) : null);
      },
    });
  };

  const submitConnect = () => {
    if (connect.isPending || !ownerId) return;
    connect.mutate({ apiKey: apiKey.trim(), ownerId });
  };

  const resetKey = () => {
    setOwners(null);
    setOwnerId(null);
    validate.reset();
    connect.reset();
  };

  const header = headerForPhase(phase);
  const error = connect.error
    ? renderErrorMessage(connect.error)
    : validate.error
      ? renderErrorMessage(validate.error)
      : null;

  return (
    <>
      <StepHeader title={header.title} sub={header.sub} />

      {phase === "start" && (
        <KeyPanel
          apiKey={apiKey}
          onChange={setApiKey}
          onSubmit={submitKey}
          pending={validate.isPending}
          error={error}
        />
      )}

      {phase === "pick" && owners && (
        <PickPanel
          owners={owners}
          ownerId={ownerId}
          onPick={setOwnerId}
          onConnect={submitConnect}
          onChangeKey={resetKey}
          pending={connect.isPending}
          error={error}
        />
      )}

      {phase === "connected" && install.data?.installed && (
        <ConnectedPanel
          ownerName={install.data.ownerName}
          services={install.data.services}
          statusText={renderStatusText(phase, eventsArrived)}
          eventsArrived={eventsArrived}
        />
      )}

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={canContinueRender(phase) ? "Continue" : "Waiting for Render…"}
        nextDisabled={!canContinueRender(phase)}
      />
      {!canContinueRender(phase) && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}

function headerForPhase(phase: "start" | "pick" | "connected"): { title: string; sub: string } {
  switch (phase) {
    case "start":
      return {
        title: "Connect Render",
        sub: "Paste a Render API key and pick the workspace to share. We pull your services' logs and infra metrics from Render's API — no agent, no code changes.",
      };
    case "pick":
      return {
        title: "Pick a workspace",
        sub: "The key checks out. Choose the Render workspace whose services should flow into this project.",
      };
    default:
      return {
        title: "You're connected",
        sub: "We're pulling logs and metrics from your Render services. First events typically appear within a minute.",
      };
  }
}

function KeyPanel({
  apiKey,
  onChange,
  onSubmit,
  pending,
  error,
}: {
  apiKey: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div className={`border-b px-[22px] py-[18px] ${SOFT_LINE}`}>
        <p className="m-0 text-[13px] leading-[1.55] text-muted">
          Create a key in Render under <span className="text-fg">Account settings → API Keys</span>.
          Render keys are account-wide (Render doesn't offer scoped keys), so we store yours
          encrypted and only ever read logs and metrics from the workspace you pick — revoke it in
          Render at any time to cut access.
        </p>
      </div>
      <form
        className="flex items-center gap-3 px-[22px] py-[16px]"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => onChange(e.target.value)}
          placeholder="rnd_…"
          autoComplete="off"
          spellCheck={false}
          className={`h-[36px] min-w-0 flex-1 rounded-[8px] border bg-surface-2 px-3 font-mono text-[13px] text-fg placeholder:text-subtle focus:outline-none ${STRONG_LINE}`}
        />
        <Btn
          variant="primary"
          size="md"
          type="submit"
          loading={pending}
          disabled={!apiKey.trim()}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {pending ? "Checking…" : "Validate key"}
        </Btn>
      </form>
      {error && (
        <div className={`border-t px-[22px] py-[12px] ${SOFT_LINE}`}>
          <p className="m-0 text-[12.5px] text-danger">{error}</p>
        </div>
      )}
    </div>
  );
}

function PickPanel({
  owners,
  ownerId,
  onPick,
  onConnect,
  onChangeKey,
  pending,
  error,
}: {
  owners: RenderOwner[];
  ownerId: string | null;
  onPick: (id: string) => void;
  onConnect: () => void;
  onChangeKey: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
      <div className="divide-y divide-[rgba(255,255,255,0.07)]">
        {owners.map((owner) => (
          <label
            key={owner.id}
            className="flex cursor-pointer items-center gap-3 px-[18px] py-[13px] transition-colors hover:bg-surface-2"
          >
            <input
              type="radio"
              name="render-owner"
              checked={ownerId === owner.id}
              onChange={() => onPick(owner.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-fg">{owner.name}</span>
              <span className="block text-[12px] text-muted">
                {owner.type === "team" ? "Team workspace" : "Personal workspace"}
                {owner.email ? ` — ${owner.email}` : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div
        className={`flex items-center justify-between gap-3 border-t px-[22px] py-[14px] ${SOFT_LINE}`}
      >
        <button
          type="button"
          onClick={onChangeKey}
          className="text-[12.5px] font-medium text-muted transition-colors hover:text-fg"
        >
          Use a different key
        </button>
        <Btn
          variant="primary"
          size="md"
          onClick={onConnect}
          loading={pending}
          disabled={!ownerId}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {pending ? "Connecting…" : "Connect workspace"}
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

function ConnectedPanel({
  ownerName,
  services,
  statusText,
  eventsArrived,
}: {
  ownerName: string | null;
  services: Array<{ id: string; name: string; type: string; suspended: boolean }>;
  statusText: string;
  eventsArrived: boolean;
}) {
  const active = services.filter((s) => !s.suspended);
  return (
    <div className="flex flex-col gap-4">
      <div className={`overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}>
        <div className={`border-b px-[18px] py-[10px] ${SOFT_LINE}`}>
          <span className="font-mono text-[12px] text-muted">
            {ownerName ? `${ownerName} — ` : ""}
            {active.length === 1 ? "1 Render service" : `${active.length} Render services`}
          </span>
        </div>
        <div className="divide-y divide-[rgba(255,255,255,0.07)]">
          {active.length === 0 ? (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
              No running services in this workspace yet — telemetry starts flowing when one deploys.
            </div>
          ) : (
            active.map((service) => (
              <div key={service.id} className="flex items-center gap-3 px-[18px] py-[13px]">
                <span className="text-success">
                  <CheckIcon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{service.name}</span>
                  <span className="block text-[12px] text-muted">
                    {service.type.replaceAll("_", " ")} — logs + metrics
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
          <div className="flex-1 text-[12.5px] text-muted">{statusText}</div>
        </div>
      )}
    </div>
  );
}
