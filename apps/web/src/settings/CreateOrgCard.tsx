import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateOrg } from "../api.ts";
import { authClient } from "../auth-client.ts";
import { Btn, Input } from "../design/ui.tsx";
import { fetchErrorMessage } from "./orgErrors.ts";
import { SettingsCard, SettingsCardFooter, SettingsRow } from "./rows.tsx";

const ORG_NAME_MAX = 80;

export function CreateOrgCard() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useCreateOrg();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    create.mutate(trimmed, {
      onSuccess: async (data) => {
        // Switch into the new org so the user lands in it, then refresh the
        // surfaces that read org context and go to the dashboard.
        await authClient.organization.setActive({ organizationId: data.org.id }).catch(() => {});
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["me"] }),
          qc.invalidateQueries({ queryKey: ["org-projects"] }),
        ]);
        setName("");
        navigate("/");
      },
      onError: (err) => setError(fetchErrorMessage(err, "Failed to create organization")),
    });
  };

  return (
    <form onSubmit={submit}>
      <SettingsCard>
        <SettingsRow
          title="New organization"
          description="Create a separate org with its own projects, members, and billing. You'll be switched to it."
          control={
            <div className="w-60">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, ORG_NAME_MAX))}
                placeholder="Acme Inc"
              />
            </div>
          }
        />
        <SettingsCardFooter>
          {error && <span className="mr-auto text-[12px] text-danger">{error}</span>}
          <Btn type="submit" size="sm" loading={create.isPending} disabled={!name.trim()}>
            Create organization
          </Btn>
        </SettingsCardFooter>
      </SettingsCard>
    </form>
  );
}
