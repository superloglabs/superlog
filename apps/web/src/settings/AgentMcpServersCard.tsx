import { useRef, useState } from "react";
import {
  type ProjectMcpAuthInput,
  type ProjectMcpServer,
  useConnectProjectMcpClientCredentials,
  useCreateProjectMcpServer,
  useDeleteProjectMcpServer,
  useDetectProjectMcpAuth,
  useDisconnectProjectMcpOAuth,
  useProjectMcpServers,
  useStartProjectMcpOAuth,
  useTestProjectMcpServer,
  useUpdateProjectMcpServer,
} from "../api.ts";
import { Btn, Chip, FieldLabel, Input } from "../design/ui.tsx";
import {
  type AuthDraft,
  EMPTY_AUTH,
  createDetectedProjectMcpAuthDraft,
  createProjectMcpEditorDraft,
} from "./project-mcp-editor.ts";
import { SettingsCard, SettingsRow } from "./rows.tsx";

export function AgentMcpServersCard({ projectId }: { projectId: string | undefined }) {
  const query = useProjectMcpServers(projectId);
  const create = useCreateProjectMcpServer(projectId);
  const detectAuth = useDetectProjectMcpAuth(projectId);
  const update = useUpdateProjectMcpServer(projectId);
  const remove = useDeleteProjectMcpServer(projectId);
  const test = useTestProjectMcpServer(projectId);
  const startOAuth = useStartProjectMcpOAuth(projectId);
  const connectClientCredentials = useConnectProjectMcpClientCredentials(projectId);
  const disconnectOAuth = useDisconnectProjectMcpOAuth(projectId);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<AuthDraft>(EMPTY_AUTH);
  const [trusted, setTrusted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [authDetection, setAuthDetection] = useState<string | null>(null);
  const [manualAuth, setManualAuth] = useState(false);
  const authManuallySelected = useRef(false);

  const servers = query.data?.servers ?? [];
  const canManage = query.data?.canManage ?? false;
  const pending =
    create.isPending ||
    detectAuth.isPending ||
    update.isPending ||
    remove.isPending ||
    test.isPending ||
    startOAuth.isPending ||
    connectClientCredentials.isPending ||
    disconnectOAuth.isPending;

  const detectAuthForUrl = async (): Promise<AuthDraft | null> => {
    setAuthDetection("Detecting auth…");
    try {
      const detected = await detectAuth.mutateAsync(url);
      if (authManuallySelected.current) return auth;
      const nextAuth = createDetectedProjectMcpAuthDraft(detected);
      setAuth(nextAuth);
      if (nextAuth.requiresClientId) {
        authManuallySelected.current = true;
        setManualAuth(true);
      }
      setAuthDetection(
        detected.type === "unknown"
          ? "Auth not detected"
          : detected.grantType === "client_credentials"
            ? "OAuth client credentials"
            : detected.supportsDynamicRegistration
              ? "OAuth detected"
              : "OAuth · client ID required",
      );
      return nextAuth.requiresClientId ? null : nextAuth;
    } catch {
      setAuthDetection("Auth detection failed");
      return auth;
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const submittedAuth = authManuallySelected.current ? auth : await detectAuthForUrl();
    if (!submittedAuth) return;
    create.mutate(
      {
        name,
        url,
        enabled: (query.data?.enabledCount ?? 0) < (query.data?.enabledLimit ?? 19),
        auth: authInput(submittedAuth),
        confirmTrusted: trusted,
      },
      {
        onSuccess: () => {
          setName("");
          setUrl("");
          setAuth(EMPTY_AUTH);
          authManuallySelected.current = false;
          setManualAuth(false);
          setAuthDetection(null);
          setTrusted(false);
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  const run = (action: () => Promise<unknown>, onSuccess?: (value: unknown) => void) => {
    setError(null);
    action()
      .then(onSuccess)
      .catch((cause) => setError(errorMessage(cause)));
  };

  if (query.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-[13px] text-muted">
        Loading MCP servers…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/[0.05] p-4 text-[13px] text-danger">
        {errorMessage(query.error)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>Remote HTTPS Streamable HTTP servers are attached to new agent sessions.</span>
        <Chip tone={query.data?.enabledCount === query.data?.enabledLimit ? "warning" : "muted"}>
          {query.data?.enabledCount ?? 0}/{query.data?.enabledLimit ?? 19} enabled
        </Chip>
      </div>

      <SettingsCard>
        {servers.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-muted">
            No custom agent MCPs yet.
          </div>
        ) : (
          servers.map((server) => (
            <SettingsRow
              key={server.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span>{server.name}</span>
                  <Chip tone="muted">{authLabel(server)}</Chip>
                  {server.auth.type === "oauth" && (
                    <Chip tone={server.auth.status === "connected" ? "success" : "warning"}>
                      {server.auth.status}
                    </Chip>
                  )}
                </span>
              }
              description={<span className="break-all font-mono text-[11.5px]">{server.url}</span>}
              control={
                <Switch
                  checked={server.enabled}
                  disabled={!canManage || pending}
                  label={`Enable ${server.name}`}
                  onChange={(enabled) => run(() => update.mutateAsync({ id: server.id, enabled }))}
                />
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Btn
                  size="sm"
                  variant="secondary"
                  disabled={!canManage || pending}
                  onClick={() =>
                    run(
                      () => test.mutateAsync(server.id),
                      (value) => {
                        const result = value as { toolCount: number };
                        setTestResult((current) => ({
                          ...current,
                          [server.id]: `Connected · ${result.toolCount} tools`,
                        }));
                      },
                    )
                  }
                >
                  Test connection
                </Btn>
                {server.auth.type === "oauth" &&
                  server.auth.grantType === "authorization_code" &&
                  server.auth.status !== "connected" && (
                    <Btn
                      size="sm"
                      disabled={!canManage || pending}
                      onClick={() =>
                        run(
                          () => startOAuth.mutateAsync(server.id),
                          (value) =>
                            window.location.assign(
                              (value as { authorizationUrl: string }).authorizationUrl,
                            ),
                        )
                      }
                    >
                      Connect OAuth
                    </Btn>
                  )}
                {server.auth.type === "oauth" &&
                  server.auth.grantType === "client_credentials" &&
                  server.auth.status !== "connected" && (
                    <Btn
                      size="sm"
                      disabled={!canManage || pending}
                      onClick={() => run(() => connectClientCredentials.mutateAsync(server.id))}
                    >
                      Connect credentials
                    </Btn>
                  )}
                {server.auth.type === "oauth" && server.auth.status === "connected" && (
                  <Btn
                    size="sm"
                    variant="secondary"
                    disabled={!canManage || pending}
                    onClick={() => run(() => disconnectOAuth.mutateAsync(server.id))}
                  >
                    Disconnect
                  </Btn>
                )}
                <ServerEditor
                  server={server}
                  disabled={!canManage || pending}
                  onSave={(patch) => run(() => update.mutateAsync({ id: server.id, ...patch }))}
                />
                <Btn
                  size="sm"
                  variant="danger"
                  disabled={!canManage || pending}
                  onClick={() => {
                    if (window.confirm(`Remove ${server.name}?`)) {
                      run(() => remove.mutateAsync(server.id));
                    }
                  }}
                >
                  Remove
                </Btn>
                {testResult[server.id] && (
                  <span className="text-[12px] text-success">{testResult[server.id]}</span>
                )}
              </div>
            </SettingsRow>
          ))
        )}
      </SettingsCard>

      {canManage ? (
        <form onSubmit={submit} className="rounded-lg border border-border bg-surface p-5">
          <div className="mb-4">
            <h3 className="text-[13.5px] font-medium text-fg">Add an agent MCP</h3>
            <p className="mt-0.5 text-[12.5px] text-muted">
              Credentials are encrypted and write-only. The remote server can receive project data
              the agent sends to its tools.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Granola"
                required
              />
            </Field>
            <Field label="Streamable HTTP URL">
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setAuthDetection(null);
                }}
                onBlur={() => {
                  if (authManuallySelected.current || !url.trim()) return;
                  void detectAuthForUrl();
                }}
                placeholder="https://mcp.example.com/mcp"
                type="url"
                required
              />
            </Field>
          </div>
          <McpAuthenticationEditor
            manual={manualAuth}
            detectionMessage={authDetection}
            value={auth}
            onChange={setAuth}
            onConfigureManually={() => {
              authManuallySelected.current = true;
              setManualAuth(true);
              setAuthDetection(null);
            }}
            onUseAutomatic={() => {
              authManuallySelected.current = false;
              setManualAuth(false);
              setAuth(EMPTY_AUTH);
              if (url.trim()) void detectAuthForUrl();
            }}
          />
          <label className="mt-4 flex items-start gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I trust this server and understand that enabled agents may send investigation context
              to it.
            </span>
          </label>
          {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
          <div className="mt-4 flex justify-end">
            <Btn
              type="submit"
              loading={create.isPending}
              disabled={!name.trim() || !url.trim() || !trusted || detectAuth.isPending}
            >
              Add MCP server
            </Btn>
          </div>
        </form>
      ) : (
        <p className="text-[12.5px] text-muted">
          Project owners and admins can change agent MCP servers.
        </p>
      )}
    </div>
  );
}

export function McpAuthenticationEditor({
  manual,
  detectionMessage,
  value,
  onChange,
  onConfigureManually,
  onUseAutomatic,
}: {
  manual: boolean;
  detectionMessage: string | null;
  value: AuthDraft;
  onChange: (next: AuthDraft) => void;
  onConfigureManually: () => void;
  onUseAutomatic: () => void;
}) {
  return (
    <div className="mt-4">
      {manual ? (
        <div>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel>Manual authentication</FieldLabel>
            <Btn type="button" size="sm" variant="secondary" onClick={onUseAutomatic}>
              Use auto
            </Btn>
          </div>
          <select
            aria-label="Manual authentication"
            value={value.type}
            onChange={(event) =>
              onChange({
                ...EMPTY_AUTH,
                type: event.target.value as AuthDraft["type"],
              })
            }
            className="h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-[13px] text-fg focus:border-border-strong focus:outline-none sm:w-64"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer / API token</option>
            <option value="api_key">API-key header</option>
            <option value="oauth">OAuth 2.1</option>
          </select>
          <AuthFields value={value} onChange={onChange} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {detectionMessage && (
            <span aria-live="polite">
              <Chip tone="muted">{detectionMessage}</Chip>
            </span>
          )}
          <Btn type="button" size="sm" variant="secondary" onClick={onConfigureManually}>
            Set auth manually
          </Btn>
        </div>
      )}
    </div>
  );
}

function ServerEditor({
  server,
  disabled,
  onSave,
}: {
  server: ProjectMcpServer;
  disabled: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const initialDraft = createProjectMcpEditorDraft(server);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialDraft.name);
  const [url, setUrl] = useState(initialDraft.url);
  const [trusted, setTrusted] = useState(initialDraft.trusted);
  const [replaceAuth, setReplaceAuth] = useState(initialDraft.replaceAuth);
  const [auth, setAuth] = useState<AuthDraft>(initialDraft.auth);
  const resetDraft = () => {
    const draft = createProjectMcpEditorDraft(server);
    setName(draft.name);
    setUrl(draft.url);
    setTrusted(draft.trusted);
    setReplaceAuth(draft.replaceAuth);
    setAuth(draft.auth);
  };
  const closeEditor = () => {
    resetDraft();
    setOpen(false);
  };
  return open ? (
    <div className="mt-2 w-full rounded-md border border-border bg-surface-2 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="MCP name" />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="MCP URL" />
      </div>
      <label className="mt-3 flex items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={trusted}
          onChange={(event) => setTrusted(event.target.checked)}
        />{" "}
        Trust the changed URL
      </label>
      <label className="mt-2 flex items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={replaceAuth}
          onChange={(event) => setReplaceAuth(event.target.checked)}
        />{" "}
        Replace authentication credentials
      </label>
      {replaceAuth && (
        <div className="mt-3">
          <select
            value={auth.type}
            onChange={(event) =>
              setAuth({
                ...EMPTY_AUTH,
                type: event.target.value as AuthDraft["type"],
              })
            }
            className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-fg"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer / API token</option>
            <option value="api_key">API-key header</option>
            <option value="oauth">OAuth 2.1</option>
          </select>
          <AuthFields value={auth} onChange={setAuth} />
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Btn size="sm" variant="ghost" onClick={closeEditor}>
          Cancel
        </Btn>
        <Btn
          size="sm"
          onClick={() => {
            const confirmTrusted = url === server.url || trusted;
            onSave({
              name,
              url,
              confirmTrusted,
              ...(replaceAuth ? { auth: authInput(auth) } : {}),
            });
            closeEditor();
          }}
        >
          Save
        </Btn>
      </div>
    </div>
  ) : (
    <Btn
      size="sm"
      variant="ghost"
      disabled={disabled}
      onClick={() => {
        resetDraft();
        setOpen(true);
      }}
    >
      Edit
    </Btn>
  );
}

function AuthFields({
  value,
  onChange,
}: { value: AuthDraft; onChange: (next: AuthDraft) => void }) {
  if (value.type === "none") return null;
  if (value.type === "bearer")
    return (
      <div className="mt-4">
        <Field label="Bearer token">
          <Input
            type="password"
            autoComplete="off"
            value={value.token}
            onChange={(e) => onChange({ ...value, token: e.target.value })}
            required
          />
        </Field>
      </div>
    );
  if (value.type === "api_key")
    return (
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Header name">
          <Input
            value={value.headerName}
            onChange={(e) => onChange({ ...value, headerName: e.target.value })}
            required
          />
        </Field>
        <Field label="API key">
          <Input
            type="password"
            autoComplete="off"
            value={value.key}
            onChange={(e) => onChange({ ...value, key: e.target.value })}
            required
          />
        </Field>
      </div>
    );
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <Field label="OAuth grant">
        <select
          value={value.grantType}
          onChange={(e) =>
            onChange({
              ...value,
              grantType: e.target.value as AuthDraft["grantType"],
            })
          }
          className="h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-[13px] text-fg"
        >
          <option value="authorization_code">Authorization code + PKCE</option>
          <option value="client_credentials">Client credentials</option>
        </select>
      </Field>
      <Field label="Scopes (space-separated)">
        <Input
          value={value.scopes}
          onChange={(e) => onChange({ ...value, scopes: e.target.value })}
          placeholder="issues:read"
        />
      </Field>
      <Field
        label={
          value.requiresClientId
            ? "Client ID"
            : "Client ID (optional with dynamic registration)"
        }
      >
        <Input
          value={value.clientId}
          onChange={(e) => onChange({ ...value, clientId: e.target.value })}
          required={value.requiresClientId}
        />
      </Field>
      <Field
        label={
          value.grantType === "client_credentials" ? "Client secret" : "Client secret (optional)"
        }
      >
        <Input
          type="password"
          autoComplete="off"
          value={value.clientSecret}
          onChange={(e) => onChange({ ...value, clientSecret: e.target.value })}
          required={value.grantType === "client_credentials"}
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full border ${checked ? "border-accent bg-accent" : "border-border bg-surface-3"} disabled:opacity-40`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-accent-ink transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}

function authInput(auth: AuthDraft): ProjectMcpAuthInput {
  if (auth.type === "none") return { type: "none" };
  if (auth.type === "bearer") return { type: "bearer", token: auth.token };
  if (auth.type === "api_key")
    return { type: "api_key", headerName: auth.headerName, key: auth.key };
  return {
    type: "oauth",
    grantType: auth.grantType,
    scopes: auth.scopes.split(/\s+/).filter(Boolean),
    ...(auth.clientId.trim() ? { clientId: auth.clientId.trim() } : {}),
    ...(auth.clientSecret ? { clientSecret: auth.clientSecret } : {}),
  };
}

function authLabel(server: ProjectMcpServer): string {
  if (server.auth.type === "none") return "No auth";
  if (server.auth.type === "bearer") return "Bearer";
  if (server.auth.type === "api_key") return server.auth.headerName;
  return server.auth.grantType === "client_credentials" ? "OAuth client credentials" : "OAuth 2.1";
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  try {
    const raw = error.message.replace(/^\d+:\s*/, "");
    const body = JSON.parse(raw) as { error?: string };
    return body.error ?? error.message;
  } catch {
    return error.message;
  }
}
