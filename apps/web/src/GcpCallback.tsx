import { useEffect, useMemo, useState } from "react";
import { useConnectGcpAuthorization, useGcpAuthorizationSelection } from "./api.ts";
import { Dropdown } from "./design/Dropdown.tsx";
import { Btn, Wordmark } from "./design/ui.tsx";
import { gcpCallbackView } from "./gcpCallbackModel.ts";
import { CheckIcon } from "./onboarding/icons.tsx";

export function GcpCallback() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("gcp");
  const authorizationId = params.get("authorization");
  if (outcome === "select") {
    return authorizationId ? (
      <GcpProjectPicker authorizationId={authorizationId} />
    ) : (
      <GcpCallbackMessage outcome="error" />
    );
  }
  return <GcpCallbackMessage outcome={outcome} />;
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="px-8 py-5">
        <Wordmark size="md" />
      </header>
      <main className="flex justify-center px-8 pb-16 pt-12">
        <div className="w-full max-w-[560px]">{children}</div>
      </main>
    </div>
  );
}

function GcpCallbackMessage({ outcome }: { outcome: string | null }) {
  const view = gcpCallbackView(outcome);
  return (
    <PageFrame>
      <h1 className="mb-7 text-[22px] font-semibold tracking-[-0.015em]">{view.title}</h1>
      <div
        className={`flex items-start gap-2.5 rounded-[10px] border px-4 py-3 ${
          view.tone === "success"
            ? "border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)]"
            : view.tone === "neutral"
              ? "border-border bg-surface"
              : "border-[rgba(240,98,98,0.35)] bg-[rgba(240,98,98,0.06)]"
        }`}
      >
        <span
          className={`mt-[2px] ${
            view.tone === "success"
              ? "text-success"
              : view.tone === "neutral"
                ? "text-muted"
                : "text-danger"
          }`}
        >
          {view.tone === "success" ? <CheckIcon size={14} /> : view.tone === "error" ? "!" : ""}
        </span>
        <p className="m-0 flex-1 text-[13px] leading-[1.55] text-fg">{view.body}</p>
      </div>
      <div className="mt-9 flex justify-end border-t border-[rgba(255,255,255,0.07)] pt-5">
        <Btn variant="primary" size="md" onClick={() => window.location.assign(view.backHref)}>
          {view.backLabel}
        </Btn>
      </div>
    </PageFrame>
  );
}

function GcpProjectPicker({ authorizationId }: { authorizationId: string }) {
  const selection = useGcpAuthorizationSelection(authorizationId);
  const connect = useConnectGcpAuthorization(authorizationId);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const options = useMemo(
    () =>
      (selection.data?.projects ?? []).map((project) => ({
        value: project.projectId,
        searchText: `${project.displayName} ${project.projectId}`,
        label: (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-fg">{project.displayName}</span>
            <span className="truncate font-mono text-[11px] text-subtle">{project.projectId}</span>
          </span>
        ),
      })),
    [selection.data?.projects],
  );

  useEffect(() => {
    if (!selectedProjectId && options.length === 1 && options[0]) {
      setSelectedProjectId(options[0].value);
    }
  }, [options, selectedProjectId]);

  if (selection.isError) {
    return <GcpCallbackMessage outcome="error" />;
  }

  return (
    <PageFrame>
      <h1 className="mb-2 text-[22px] font-semibold tracking-[-0.015em]">
        Choose a Google Cloud project
      </h1>
      <p className="mb-7 text-[13px] leading-[1.55] text-muted">
        Select one of the active projects available to your Google account. The authorization
        expires after ten minutes and can only be used once.
      </p>

      {selection.isPending ? (
        <div className="h-9 animate-pulse rounded-md border border-border bg-surface-2" />
      ) : options.length === 0 ? (
        <div className="rounded-[10px] border border-[rgba(240,98,98,0.35)] bg-[rgba(240,98,98,0.06)] px-4 py-3 text-[13px] text-fg">
          This Google account has no active projects available to connect.
        </div>
      ) : (
        <Dropdown
          value={selectedProjectId}
          onChange={setSelectedProjectId}
          options={options}
          placeholder="Search Google Cloud projects…"
          emptyLabel="No projects match your search"
        />
      )}

      {connect.error && <p className="mt-3 text-[12.5px] text-danger">{String(connect.error)}</p>}
      <div className="mt-9 flex items-center justify-between border-t border-[rgba(255,255,255,0.07)] pt-5">
        <Btn size="md" onClick={() => window.location.assign("/settings")}>
          Cancel
        </Btn>
        <Btn
          variant="primary"
          size="md"
          loading={connect.isPending}
          disabled={!selectedProjectId || connect.isPending}
          onClick={async () => {
            await connect.mutateAsync(selectedProjectId);
            window.location.assign("/connect/gcp?gcp=connected");
          }}
        >
          Connect project
        </Btn>
      </div>
    </PageFrame>
  );
}
