import { useMemo, useState } from "react";
import { useConnectSentryProject, useSentryAuthorization } from "../api.ts";
import { Dropdown } from "../design/Dropdown.tsx";
import { Btn } from "../design/ui.tsx";

export function SentryProjectPicker({
  projectId,
  authorizationId,
  onConnected,
}: {
  projectId: string | undefined;
  authorizationId: string;
  onConnected: () => void;
}) {
  const authorization = useSentryAuthorization(projectId, authorizationId);
  const connect = useConnectSentryProject(projectId, authorizationId);
  const [projectSlug, setProjectSlug] = useState("");
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
      <p className="text-[12.5px] text-danger">
        This Sentry authorization expired or is no longer available. Start the connection again.
      </p>
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
