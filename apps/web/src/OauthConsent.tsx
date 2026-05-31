import { useEffect, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { AuthForm } from "./AuthForm.tsx";
import { useSession } from "./auth-client.ts";
import { Btn, CenteredShell, Chip, Label, Tile, Wordmark } from "./design/ui.tsx";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope: string | null;
};

function readParams(): AuthorizeParams {
  const q = new URLSearchParams(window.location.search);
  return {
    clientId: q.get("client_id") ?? "",
    redirectUri: q.get("redirect_uri") ?? "",
    state: q.get("state"),
    codeChallenge: q.get("code_challenge") ?? "",
    codeChallengeMethod: q.get("code_challenge_method") ?? "",
    resource: q.get("resource") ?? "",
    scope: q.get("scope"),
  };
}

export function OauthConsent() {
  const params = readParams();
  const { data, isPending } = useSession();

  return (
    <CenteredShell>
      <div className="flex w-full max-w-md flex-col items-center">
        <Wordmark size="lg" />
        <Label>Authorize MCP client</Label>
        <div className="mt-8 w-full">
          {isPending ? (
            <Tile>
              <p className="text-[13px] text-muted">Loading…</p>
            </Tile>
          ) : data ? (
            <ConsentCard params={params} />
          ) : (
            <AuthForm
              initialMode="sign-in"
              onSuccess={() => {
                window.location.reload();
              }}
            />
          )}
        </div>
      </div>
    </CenteredShell>
  );
}

type MeResponse = {
  user: { id: string; email: string };
  org: { id: string; name: string; slug: string };
  project: { id: string; name: string; slug: string };
};

type ClientInfo = { id: string; name: string };

function ConsentCard({ params }: { params: AuthorizeParams }) {
  const posthog = usePostHog();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready" } | { kind: "working" } | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, clientRes] = await Promise.all([
          fetch(`${API_URL}/api/me`, { credentials: "include" }),
          fetch(`${API_URL}/api/mcp/oauth/client/${params.clientId}`, { credentials: "include" }),
        ]);
        if (!meRes.ok) throw new Error(`me: ${meRes.status}`);
        if (!clientRes.ok) throw new Error(`client: ${clientRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as MeResponse);
        setClient((await clientRes.json()) as ClientInfo);
        setState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.clientId]);

  async function decide(decision: "allow" | "deny") {
    if (!me) return;
    posthog.capture(decision === "allow" ? "mcp_oauth_authorized" : "mcp_oauth_denied", {
      client_id: params.clientId,
      project_id: me.project.id,
    });
    setState({ kind: "working" });
    try {
      const res = await fetch(`${API_URL}/api/mcp/oauth/decision`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: params.clientId,
          redirect_uri: params.redirectUri,
          state: params.state,
          code_challenge: params.codeChallenge,
          code_challenge_method: params.codeChallengeMethod,
          resource: params.resource,
          scope: params.scope,
          project_id: me.project.id,
          decision,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        setState({ kind: "error", message: `${res.status}: ${body}` });
        return;
      }
      const { redirect_uri } = (await res.json()) as { redirect_uri: string };
      window.location.href = redirect_uri;
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (state.kind === "loading") {
    return (
      <Tile>
        <p className="text-[13px] text-muted">Loading…</p>
      </Tile>
    );
  }
  if (state.kind === "error") {
    return (
      <Tile>
        <p className="font-mono text-[11px] text-danger">{state.message}</p>
      </Tile>
    );
  }

  return (
    <Tile>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            client
          </span>
          <div className="text-[15px] font-medium text-fg">{client?.name ?? "MCP client"}</div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            will access
          </span>
          <div className="text-[13px] text-fg">
            Read logs, traces, and metrics for project{" "}
            <span className="font-medium">{me?.project.name}</span> in org{" "}
            <span className="font-medium">{me?.org.name}</span>.
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Chip tone="neutral">resource: {params.resource}</Chip>
        </div>

        <div className="flex gap-2">
          <Btn
            variant="primary"
            size="lg"
            className="flex-1 justify-center"
            loading={state.kind === "working"}
            onClick={() => decide("allow")}
          >
            Authorize
          </Btn>
          <Btn
            variant="ghost"
            size="lg"
            className="flex-1 justify-center"
            disabled={state.kind === "working"}
            onClick={() => decide("deny")}
          >
            Deny
          </Btn>
        </div>
      </div>
    </Tile>
  );
}
