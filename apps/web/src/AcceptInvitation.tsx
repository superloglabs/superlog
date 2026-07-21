import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { AuthForm } from "./AuthForm.tsx";
import { authClient, useSession } from "./auth-client.ts";
import { Btn, CenteredShell, Wordmark } from "./design/ui.tsx";

type InviteDetails = {
  id: string;
  organizationName: string;
  organizationSlug: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  inviterEmail: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; invite: InviteDetails }
  | { kind: "error"; message: string };

export function AcceptInvitation() {
  const [params] = useSearchParams();
  const id = params.get("id");
  const session = useSession();

  if (!id) {
    return (
      <CenteredShell>
        <Wordmark />
        <p className="mt-6 text-[13px] text-muted">Missing invitation id.</p>
      </CenteredShell>
    );
  }

  if (session.isPending) return null;
  if (!session.data) {
    return <InvitationAuthentication id={id} />;
  }

  return (
    <AcceptInvitationInner
      id={id}
      userEmail={session.data.user.email}
      autoAccept={params.get("join") === "1"}
    />
  );
}

function InvitationAuthentication({ id }: { id: string }) {
  const continuationUrl = `${window.location.origin}/accept-invitation?id=${encodeURIComponent(id)}&join=1`;

  return (
    <CenteredShell>
      <Wordmark />
      <div className="mt-8 w-full max-w-md">
        <div className="mb-4 text-center">
          <h1 className="text-[17px] font-medium text-fg">You&apos;re invited</h1>
          <p className="mt-2 text-[13px] text-muted">
            You&apos;ve been invited to join an organization. Sign in or create an account to
            continue.
          </p>
        </div>
        <AuthForm
          initialMode="sign-up"
          socialCallbackURL={continuationUrl}
          onSuccess={() => window.location.assign(continuationUrl)}
        />
      </div>
    </CenteredShell>
  );
}

function AcceptInvitationInner({
  id,
  userEmail,
  autoAccept,
}: {
  id: string;
  userEmail: string;
  autoAccept: boolean;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [action, setAction] = useState<
    "idle" | "accepting" | "rejecting" | "accepted" | "rejected"
  >("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const qc = useQueryClient();
  const autoAcceptAttempted = useRef(false);

  const accept = useCallback(async () => {
    setAction("accepting");
    setActionError(null);
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    if (res.error) {
      console.error("[AcceptInvitation] acceptInvitation failed", {
        invitationId: id,
        error: res.error.message,
      });
      setAction("idle");
      setActionError(res.error.message ?? "Failed to accept invitation.");
      return;
    }
    const orgId = (res.data as unknown as { invitation: { organizationId: string } }).invitation
      .organizationId;
    const setActiveRes = await authClient.organization.setActive({ organizationId: orgId });
    if (setActiveRes.error) {
      console.error("[AcceptInvitation] setActive failed after acceptance", {
        invitationId: id,
        organizationId: orgId,
        error: setActiveRes.error.message,
      });
      // The invitation is already accepted at this point — surface the
      // switch failure so the user can retry from the org switcher instead
      // of landing in a stale active-org state.
      setAction("idle");
      setActionError(
        setActiveRes.error.message ??
          "Invitation accepted, but switching to the org failed. Use the org switcher to open it.",
      );
      return;
    }
    qc.clear();
    setAction("accepted");
  }, [id, qc]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await authClient.organization.getInvitation({ query: { id } });
      if (cancelled) return;
      if (res.error) {
        setState({
          kind: "error",
          message: res.error.message ?? "Invitation not found or expired.",
        });
        return;
      }
      const data = res.data as unknown as InviteDetails;
      setState({ kind: "ready", invite: data });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (autoAcceptAttempted.current) return;
    if (
      !autoAccept ||
      action !== "idle" ||
      state.kind !== "ready" ||
      state.invite.email.toLowerCase() !== userEmail.toLowerCase()
    ) {
      return;
    }
    autoAcceptAttempted.current = true;
    void accept();
  }, [accept, action, autoAccept, state, userEmail]);

  if (state.kind === "loading") {
    return (
      <CenteredShell>
        <Wordmark />
        <p className="mt-6 text-[13px] text-muted">Loading invitation…</p>
      </CenteredShell>
    );
  }

  if (state.kind === "error") {
    return (
      <CenteredShell>
        <Wordmark />
        <p className="mt-6 text-[13px] text-danger">{state.message}</p>
        <Link to="/" className="mt-4 text-[12px] text-muted underline">
          Back to Superlog
        </Link>
      </CenteredShell>
    );
  }

  const invite = state.invite;
  const wrongAccount = invite.email.toLowerCase() !== userEmail.toLowerCase();

  if (action === "accepted") {
    return <Navigate to="/app" replace />;
  }
  if (action === "rejected") {
    return (
      <CenteredShell>
        <Wordmark />
        <p className="mt-6 text-[13px] text-muted">Invitation declined.</p>
        <Link to="/" className="mt-4 text-[12px] text-muted underline">
          Back to Superlog
        </Link>
      </CenteredShell>
    );
  }

  const reject = async () => {
    setAction("rejecting");
    setActionError(null);
    const res = await authClient.organization.rejectInvitation({ invitationId: id });
    if (res.error) {
      setAction("idle");
      setActionError(res.error.message ?? "Failed to decline invitation.");
      return;
    }
    setAction("rejected");
  };

  return (
    <CenteredShell>
      <Wordmark />
      <div className="mt-8 w-full max-w-md rounded-2xl border border-border bg-surface p-6">
        <h1 className="text-[15px] font-medium">Join {invite.organizationName}</h1>
        <p className="mt-2 text-[13px] text-muted">
          You've been invited to join <strong className="text-fg">{invite.organizationName}</strong>{" "}
          as <strong className="text-fg">{invite.role}</strong>.
        </p>
        {wrongAccount && (
          <p className="mt-3 text-[12px] text-warning">
            This invite was sent to {invite.email}, but you're signed in as {userEmail}. Sign out
            and sign in with the invited address to accept.
          </p>
        )}
        {actionError && <p className="mt-3 text-[12px] text-danger">{actionError}</p>}
        <div className="mt-5 flex items-center gap-2">
          <Btn
            onClick={accept}
            loading={action === "accepting"}
            disabled={wrongAccount || action !== "idle"}
          >
            Accept
          </Btn>
          <Btn
            variant="ghost"
            onClick={reject}
            loading={action === "rejecting"}
            disabled={action !== "idle"}
          >
            Decline
          </Btn>
        </div>
      </div>
    </CenteredShell>
  );
}
