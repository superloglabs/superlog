import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDeleteOrg, useMe } from "../api.ts";
import { authClient, useListOrganizations } from "../auth-client.ts";
import { Btn, Input } from "../design/ui.tsx";
import { nextOrgIdAfterDelete } from "./nav.ts";
import { fetchErrorMessage } from "./orgErrors.ts";
import { SettingsCard, SettingsCardFooter, SettingsRow } from "./rows.tsx";

export function OrgDangerCard() {
  const me = useMe();
  const orgId = me.data?.org?.id;
  const orgName = me.data?.org?.name ?? "";
  const myUserId = me.data?.user.id;

  const orgsQ = useListOrganizations();
  const membersQ = useQuery({
    queryKey: orgId ? ["org-members", orgId] : ["org-members", "none"],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await authClient.organization.listMembers({ query: { organizationId: orgId } });
      if (res.error) throw new Error(res.error.message ?? "Failed to load members");
      return (res.data?.members ?? []) as Array<{ userId: string; role: string }>;
    },
  });

  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useDeleteOrg();

  if (!orgId) return null;

  const myRole = membersQ.data?.find((m) => m.userId === myUserId)?.role ?? "member";
  const isOwner = myRole === "owner";
  const orgCount = orgsQ.data?.length ?? 1;
  const isLastOrg = orgCount <= 1;
  const blockedReason = !isOwner
    ? "Only an owner can delete this organization."
    : isLastOrg
      ? "You can't delete your only organization — create another one first."
      : null;
  const confirmed = confirm.trim() === orgName;

  const onDelete = () => {
    setError(null);
    del.mutate(orgId, {
      onSuccess: async () => {
        // Switch into a remaining org before the deleted one disappears from
        // under the active session, then refresh and go to the dashboard.
        const nextId = nextOrgIdAfterDelete(orgsQ.data ?? [], orgId);
        if (nextId) {
          await authClient.organization.setActive({ organizationId: nextId }).catch(() => {});
        }
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["me"] }),
          qc.invalidateQueries({ queryKey: ["org-projects"] }),
        ]);
        navigate("/");
      },
      onError: (err) => setError(fetchErrorMessage(err, "Failed to delete organization")),
    });
  };

  return (
    <SettingsCard className="border-danger/40">
      <SettingsRow
        title="Delete this organization"
        description={
          blockedReason ??
          `Permanently deletes ${orgName} and all its projects, members, and data. This can't be undone.`
        }
        control={
          blockedReason ? null : (
            <div className="w-60">
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={`Type "${orgName}" to confirm`}
              />
            </div>
          )
        }
      />
      {!blockedReason && (
        <SettingsCardFooter>
          {error && <span className="mr-auto text-[12px] text-danger">{error}</span>}
          <Btn
            type="button"
            size="sm"
            variant="danger"
            loading={del.isPending}
            disabled={!confirmed}
            onClick={onDelete}
          >
            Delete organization
          </Btn>
        </SettingsCardFooter>
      )}
    </SettingsCard>
  );
}
