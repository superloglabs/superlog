import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useMe } from "../api.ts";
import { authClient } from "../auth-client.ts";
import { Btn, Input, Tile } from "../design/ui.tsx";

export function OrgGeneralCard() {
  const me = useMe();
  // Source of truth is /api/me — Better Auth's `useActiveOrganization` keeps
  // its own nanostore cache that's awkward to invalidate from tanstack-query.
  // Our backend reads the same orgs row, so after an update we invalidate
  // ["me"] and call setActive() below to nudge BA's store, then both surfaces
  // (this form + the org switcher header) re-render with the new value.
  const orgId = me.data?.org?.id;
  const orgName = me.data?.org?.name ?? "";
  const orgSlug = me.data?.org?.slug ?? "";

  const [name, setName] = useState(orgName);
  const [slug, setSlug] = useState(orgSlug);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    setName(orgName);
    setSlug(orgSlug);
  }, [orgName, orgSlug]);

  const update = useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      if (!orgId) throw new Error("No active org");
      const res = await authClient.organization.update({
        data: { name: input.name, slug: input.slug },
        organizationId: orgId,
      });
      if (res.error) throw new Error(res.error.message ?? "Failed to update org");
      return res.data;
    },
    onSuccess: async () => {
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
      void qc.invalidateQueries({ queryKey: ["me"] });
      // Force Better Auth's active-org nanostore to refetch so anywhere
      // reading `useActiveOrganization()` (e.g. the org switcher dropdown)
      // sees the new name/slug without a hard reload.
      if (orgId) {
        await authClient.organization.setActive({ organizationId: orgId }).catch(() => {});
      }
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    if (trimmedName === orgName && trimmedSlug === orgSlug) return;
    update.mutate(
      { name: trimmedName, slug: trimmedSlug },
      { onError: (e) => setError(e instanceof Error ? e.message : String(e)) },
    );
  };

  const dirty = name.trim() !== orgName || slug.trim() !== orgSlug;

  return (
    <Tile>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1.5 block text-[12px] text-muted">Organization name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] text-muted">Slug</label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="acme"
          />
          <p className="mt-1 text-[11px] text-subtle">
            Lowercase letters, numbers, and dashes. Used in URLs and emails.
          </p>
        </div>
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="flex items-center gap-2">
          <Btn type="submit" loading={update.isPending} disabled={!dirty || !name.trim()}>
            Save
          </Btn>
          {savedTick && <span className="text-[12px] text-success">Saved</span>}
        </div>
      </form>
    </Tile>
  );
}
