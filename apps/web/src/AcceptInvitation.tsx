import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { authClient, useSession } from "./auth-client.ts";
import { Landing } from "./Landing.tsx";
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
  | { kind: "wrong-account" }
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
    // /accept-invitation stays in the URL bar; once the user signs in via
    // the modal the session hook updates and we fall through to the inner
    // component without a navigation.
    return <Landing initialAuthMode="sign-up" />;
  }

  return <AcceptInvitationInner id={id} />;
}

function AcceptInvitationInner({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [action, setAction] = useState<"idle" | "accepting" | "rejecting" | "accepted" | "rejected">(
    "idle",
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await authClient.organization.getInvitation({ query: { id } });
      if (cancelled) return;
      if (res.error) {
        if (res.error.message === "You are not the recipient of the invitation") {
          setState({ kind: "wrong-account" });
        } else {
          setState({ kind: "error", message: res.error.message ?? "Invitation not found or expired." });
        }
        return;
      }
      const data = res.data as unknown as InviteDetails;
      setState({ kind: "ready", invite: data });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

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

  if (state.kind === "wrong-account") {
    const signOut = async () => {
      await authClient.signOut();
    };
    return (
      <CenteredShell>
        <Wordmark />
        <p className="mt-6 text-[13px] text-warning">
          This invitation was sent to a different email address. Sign out and sign in with the
          invited address to accept it.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Btn onClick={signOut}>Sign out</Btn>
          <Link to="/" className="text-[12px] text-muted underline">
            Back to Superlog
          </Link>
        </div>
      </CenteredShell>
    );
  }

  const invite = state.invite;

  if (action === "accepted") {
    return <Navigate to="/" replace />;
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

  const accept = async () => {
    setAction("accepting");
    setActionError(null);
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    if (res.error) {
      setAction("idle");
      setActionError(res.error.message ?? "Failed to accept invitation.");
      return;
    }
    const orgId = (res.data as unknown as { invitation: { organizationId: string } }).invitation
      .organizationId;
    const setActiveRes = await authClient.organization.setActive({ organizationId: orgId });
    if (setActiveRes.error) {
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
  };

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
        {actionError && <p className="mt-3 text-[12px] text-danger">{actionError}</p>}
        <div className="mt-5 flex items-center gap-2">
          <Btn onClick={accept} loading={action === "accepting"} disabled={action !== "idle"}>
            Accept
          </Btn>
          <Btn variant="ghost" onClick={reject} loading={action === "rejecting"} disabled={action !== "idle"}>
            Decline
          </Btn>
        </div>
      </div>
    </CenteredShell>
  );
}
