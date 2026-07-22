import { useMemo, useState } from "react";
import { useConnectSentryProject, useSentryAuthorization } from "../api.ts";
import { Dropdown } from "../design/Dropdown.tsx";
import { Btn } from "../design/ui.tsx";

export function SentryProjectPicker({
  projectId,
  authorizationId,
  onConnected,
  onRestart,
}: {
  projectId: string | undefined;
  authorizationId: string;
  onConnected: () => void;
  onRestart: () => Promise<void>;
}) {
  const authorization = useSentryAuthorization(projectId, authorizationId);
  const connect = useConnectSentryProject(projectId, authorizationId);
  const [projectSlug, setProjectSlug] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<unknown>(null);
  const options = useMemo(
    () =>
      (authorization.data?.projects ?? []).map((project) => ({
        value: project.slug,
        label: project.name,
        searchText: `${project.name} ${project.slug}`,
      })),
    [authorization.data?.projects],
  );

  if (authorization.isLoading) {
    return <p className="text-[12.5px] text-muted">Loading Sentry projects…</p>;
  }
  if (authorization.error || !authorization.data) {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-danger">
          This Sentry authorization expired or is no longer available.
        </p>
        <Btn
          size="sm"
          variant="primary"
          loading={restarting}
          disabled={restarting}
          onClick={async () => {
            setRestartError(null);
            setRestarting(true);
            try {
              await onRestart();
            } catch (error) {
              setRestartError(error);
              setRestarting(false);
            }
          }}
        >
          Restart connection
        </Btn>
        {restartError !== null && (
          <p className="text-[12.5px] text-danger">{String(restartError)}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted">
        Organization{" "}
        <span className="font-mono text-fg">{authorization.data.organizationSlug}</span> has
        multiple projects. Choose which one maps to this Superlog project.
      </p>
      <Dropdown
        value={projectSlug}
        onChange={setProjectSlug}
        options={options}
        placeholder="Choose a Sentry project…"
        disabled={connect.isPending}
      />
      <Btn
        size="sm"
        variant="primary"
        loading={connect.isPending}
        disabled={!projectSlug || connect.isPending}
        onClick={async () => {
          await connect.mutateAsync(projectSlug);
          onConnected();
        }}
      >
        Connect project
      </Btn>
      {connect.error && <p className="text-[12.5px] text-danger">{String(connect.error)}</p>}
    </div>
  );
}
