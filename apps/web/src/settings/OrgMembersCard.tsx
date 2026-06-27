import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMe } from "../api.ts";
import { authClient } from "../auth-client.ts";
import { Btn, Chip, Input, Tile } from "../design/ui.tsx";

// HTTP status returned by better-auth when the caller is not a member of the
// queried organization (stale `me` cache race: the session already switched to
// a new org but the cached me.data.org.id still points to the old one).
const NOT_MEMBER_STATUS = 403;

type Role = "owner" | "admin" | "member";
const ROLES: Role[] = ["owner", "admin", "member"];

type Member = {
  id: string;
  role: string;
  createdAt: Date | string;
  userId: string;
  user: { id: string; email: string; name?: string | null; image?: string | null };
};

type Invitation = {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date | string;
};

function memberQueryKey(orgId: string) {
  return ["org-members", orgId] as const;
}
function inviteQueryKey(orgId: string) {
  return ["org-invitations", orgId] as const;
}

export function OrgMembersCard() {
  const me = useMe();
  const qc = useQueryClient();
  const orgId = me.data?.org?.id;
  const myUserId = me.data?.user.id;

  const membersQ = useQuery({
    queryKey: orgId ? memberQueryKey(orgId) : ["org-members", "none"],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await authClient.organization.listMembers({ query: { organizationId: orgId } });
      if (res.error) {
        // 403 means the me cache is stale: the session already switched to a
        // new org but this query fired before the ["me"] refetch completed.
        // Invalidate me so the component re-renders with the correct orgId.
        if (res.error.status === NOT_MEMBER_STATUS) {
          void qc.invalidateQueries({ queryKey: ["me"] });
          return [] as Member[];
        }
        throw new Error(res.error.message ?? "Failed to load members");
      }
      return (res.data?.members ?? []) as Member[];
    },
  });

  const invitesQ = useQuery({
    queryKey: orgId ? inviteQueryKey(orgId) : ["org-invitations", "none"],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await authClient.organization.listInvitations({
        query: { organizationId: orgId },
      });
      if (res.error) {
        // Same stale-cache guard as membersQ above.
        if (res.error.status === NOT_MEMBER_STATUS) {
          void qc.invalidateQueries({ queryKey: ["me"] });
          return [] as Invitation[];
        }
        throw new Error(res.error.message ?? "Failed to load invitations");
      }
      return (res.data ?? []) as Invitation[];
    },
  });

  if (!orgId) return null;

  const myRole = membersQ.data?.find((m) => m.userId === myUserId)?.role ?? "member";
  const canManage = myRole === "owner" || myRole === "admin";

  return (
    <div className="flex flex-col gap-4">
      <InviteForm orgId={orgId} canManage={canManage} />

      <Tile padded={false}>
        <div className="border-b border-border px-5 py-3">
          <span className="text-[12px] text-muted">Members</span>
        </div>
        {membersQ.isLoading ? (
          <div className="px-5 py-6 text-[12px] text-muted">Loading…</div>
        ) : membersQ.error ? (
          <div className="px-5 py-6 text-[12px] text-danger">{String(membersQ.error)}</div>
        ) : (
          <ul className="divide-y divide-border">
            {(membersQ.data ?? []).map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                orgId={orgId}
                isSelf={m.userId === myUserId}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </Tile>

      {(invitesQ.data?.filter((i) => i.status === "pending").length ?? 0) > 0 && (
        <Tile padded={false}>
          <div className="border-b border-border px-5 py-3">
            <span className="text-[12px] text-muted">Pending invitations</span>
          </div>
          <ul className="divide-y divide-border">
            {(invitesQ.data ?? [])
              .filter((i) => i.status === "pending")
              .map((inv) => (
                <InvitationRow key={inv.id} invitation={inv} orgId={orgId} canManage={canManage} />
              ))}
          </ul>
        </Tile>
      )}
    </div>
  );
}

function InviteForm({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const qc = useQueryClient();

  const invite = useMutation({
    mutationFn: async (input: { email: string; role: Role }) => {
      const res = await authClient.organization.inviteMember({
        email: input.email,
        role: input.role,
        organizationId: orgId,
      });
      if (res.error) throw new Error(res.error.message ?? "Failed to invite");
      return res.data;
    },
    onSuccess: (_data, vars) => {
      setEmail("");
      setSuccess(`Invitation sent to ${vars.email}`);
      setTimeout(() => setSuccess(null), 3000);
      void qc.invalidateQueries({ queryKey: inviteQueryKey(orgId) });
    },
  });

  if (!canManage) {
    return (
      <Tile>
        <p className="text-[12px] text-muted">
          Only owners and admins can invite new members. Ask one of them for access.
        </p>
      </Tile>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const trimmed = email.trim();
    if (!trimmed) return;
    invite.mutate(
      { email: trimmed, role },
      { onError: (e) => setError(e instanceof Error ? e.message : String(e)) },
    );
  };

  return (
    <Tile>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1.5 block text-[12px] text-muted">Invite by email</label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            required
          />
        </div>
        <div className="w-full sm:w-40">
          <label className="mb-1.5 block text-[12px] text-muted">Role</label>
          <RoleSelect value={role} onChange={(v) => setRole(v)} />
        </div>
        <Btn type="submit" loading={invite.isPending} disabled={!email.trim()}>
          Send invite
        </Btn>
      </form>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {success && <p className="mt-2 text-[12px] text-success">{success}</p>}
    </Tile>
  );
}

function MemberRow({
  member,
  orgId,
  isSelf,
  canManage,
}: {
  member: Member;
  orgId: string;
  isSelf: boolean;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const updateRole = useMutation({
    mutationFn: async (newRole: Role) => {
      const res = await authClient.organization.updateMemberRole({
        memberId: member.id,
        role: newRole,
        organizationId: orgId,
      });
      if (res.error) throw new Error(res.error.message ?? "Failed to update role");
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: memberQueryKey(orgId) }),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await authClient.organization.removeMember({
        memberIdOrEmail: member.id,
        organizationId: orgId,
      });
      if (res.error) throw new Error(res.error.message ?? "Failed to remove member");
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: memberQueryKey(orgId) }),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const role = member.role as Role;
  const canEditRole = canManage && !isSelf;

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] text-fg">
            {member.user.name?.trim() || member.user.email}
          </span>
          {isSelf && <Chip tone="muted">you</Chip>}
        </div>
        {member.user.name?.trim() && (
          <div className="truncate text-[11px] text-subtle">{member.user.email}</div>
        )}
        {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center gap-2">
        {canEditRole ? (
          <RoleSelect
            value={role}
            disabled={updateRole.isPending}
            onChange={(v) => {
              if (v === role) return;
              setError(null);
              updateRole.mutate(v);
            }}
          />
        ) : (
          <Chip tone={role === "owner" ? "accent" : "neutral"}>{role}</Chip>
        )}
        {canManage && !isSelf && (
          <Btn
            variant="danger"
            size="sm"
            loading={remove.isPending}
            onClick={() => {
              if (!window.confirm(`Remove ${member.user.email} from this org?`)) return;
              setError(null);
              remove.mutate();
            }}
          >
            Remove
          </Btn>
        )}
      </div>
    </li>
  );
}

function InvitationRow({
  invitation,
  orgId,
  canManage,
}: {
  invitation: Invitation;
  orgId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: async () => {
      const res = await authClient.organization.cancelInvitation({
        invitationId: invitation.id,
      });
      if (res.error) throw new Error(res.error.message ?? "Failed to cancel");
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: inviteQueryKey(orgId) }),
    onError: (e) => setCancelError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">{invitation.email}</div>
        <div className="text-[11px] text-subtle">
          Invited as {invitation.role ?? "member"} · expires{" "}
          {new Date(invitation.expiresAt).toLocaleDateString()}
        </div>
        {cancelError && <div className="mt-1 text-[11px] text-danger">{cancelError}</div>}
      </div>
      {canManage && (
        <Btn
          variant="ghost"
          size="sm"
          loading={cancel.isPending}
          onClick={() => {
            setCancelError(null);
            cancel.mutate();
          }}
        >
          Cancel
        </Btn>
      )}
    </li>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (next: Role) => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Role)}
        className="h-8 appearance-none rounded-sm border border-border bg-surface-2 pl-3 pr-7 text-[12.5px] text-fg focus:border-border-strong focus:outline-none disabled:opacity-50"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}
