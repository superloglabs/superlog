import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import {
  authClient,
  useActiveOrganization,
  useListOrganizations,
  useSession,
} from "./auth-client.ts";
import { Btn, Wordmark } from "./design/ui.tsx";
import { CheckIcon, GithubIcon, SpinnerIcon, TerminalIcon } from "./onboarding/icons.tsx";
import { SKILL_ONBOARDING_KEY_CACHE, startSkillOnboarding } from "./skillOnboarding.ts";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";
const SOFT_LINE = "border-[rgba(255,255,255,0.07)]";
const STRONG_LINE = "border-[rgba(255,255,255,0.12)]";

export function Activate() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code") ?? "";
  const ghParam = params.get("gh") ?? "";
  const slackParam = params.get("slack") ?? "";
  const flow = params.get("flow") === "skill" ? "skill" : "cli";
  const session = useSession();

  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="px-8 py-5">
        <Wordmark size="md" />
      </header>

      <main className="flex justify-center px-8 pb-16 pt-12">
        <div className="w-full max-w-[640px]">
          {session.isPending ? null : !session.data ? (
            <AuthCard flow={flow} />
          ) : (
            <ApproveFlow code={code} ghParam={ghParam} slackParam={slackParam} flow={flow} />
          )}
        </div>
      </main>
    </div>
  );
}

function AuthCard({ flow }: { flow: "cli" | "skill" }) {
  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col items-center">
      <AuthForm initialMode={flow === "skill" ? "sign-up" : "sign-in"} />
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: React.ReactNode }) {
  return (
    <div className="mb-7 px-1">
      <h1 className="m-0 text-[22px] font-semibold leading-[1.2] tracking-[-0.015em] text-fg">
        {title}
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{subtitle}</p>
    </div>
  );
}

function Card({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-[#0a0a0c] ${SOFT_LINE}`}>
      {label && (
        <div
          className={`flex items-center gap-2 border-b bg-[rgba(255,255,255,0.02)] px-[22px] py-2 ${SOFT_LINE}`}
        >
          <span className="flex gap-1.5">
            <span className="h-[10px] w-[10px] rounded-full bg-[#3b3b3e]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#3b3b3e]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#3b3b3e]" />
          </span>
          <span className="ml-2 text-[11px] uppercase tracking-[0.08em] text-subtle">{label}</span>
        </div>
      )}
      <div className="px-[22px] py-[18px]">{children}</div>
    </div>
  );
}

type CardState =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "github" }
  | { kind: "finalizing" }
  | { kind: "done" }
  | { kind: "step-done"; step: "github" | "slack" }
  | { kind: "error"; message: string };

function ApproveFlow({
  code,
  ghParam,
  slackParam,
  flow,
}: {
  code: string;
  ghParam: string;
  slackParam: string;
  flow: "cli" | "skill";
}) {
  const scope = useScopeSelection();
  const initial: CardState = (() => {
    if (flow === "skill") {
      if (slackParam === "done") return { kind: "step-done", step: "slack" } as CardState;
      if (ghParam === "done" || ghParam === "updated")
        return { kind: "step-done", step: "github" } as CardState;
    } else if (ghParam === "done" || ghParam === "updated") {
      return { kind: "finalizing" } as CardState;
    }
    if (ghParam === "expired")
      return {
        kind: "error",
        message: "Activation code expired. Restart pairing from your agent.",
      } as CardState;
    if (ghParam === "error")
      return {
        kind: "error",
        message: "GitHub install failed. You can retry or skip.",
      } as CardState;
    return { kind: "idle" } as CardState;
  })();
  const [state, setState] = useState<CardState>(initial);

  async function finalize() {
    setState({ kind: "finalizing" });
    try {
      const res = await fetch(`${API_URL}/activate/finalize`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: code }),
      });
      if (!res.ok) {
        const body = await res.text();
        setState({ kind: "error", message: `${res.status}: ${body}` });
        return;
      }
      setState({ kind: "done" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    if (state.kind === "finalizing") void finalize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!code) {
    return (
      <>
        <PageHeader
          title="Missing activation code"
          subtitle={
            flow === "skill"
              ? "Restart pairing from your agent — re-run the Superlog onboarding skill in your terminal."
              : "Start the CLI again with `superlog init`."
          }
        />
        <Card>
          <div className="flex items-center gap-2.5 text-[13px] text-muted">
            <TerminalIcon />
            <span>This page expects a `?code=…` parameter generated by the agent.</span>
          </div>
        </Card>
      </>
    );
  }

  async function approve() {
    setState({ kind: "approving" });
    try {
      const res = await fetch(`${API_URL}/activate/approve`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_code: code,
          org_id: scope.selectedOrgId,
          project_id: scope.selectedProjectId,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        setState({ kind: "error", message: `${res.status}: ${body}` });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        githubSetupNeeded?: boolean;
        flow?: string;
        ingestKey?: string;
      };
      if (data.flow === "skill") {
        startSkillOnboarding();
        if (data.ingestKey) {
          try {
            window.sessionStorage.setItem(SKILL_ONBOARDING_KEY_CACHE, data.ingestKey);
          } catch {
            /* ignore */
          }
        }
        window.location.assign("/app");
        return;
      }
      if (data.githubSetupNeeded === false) {
        void finalize();
        return;
      }
      setState({ kind: "github" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function connectGithub() {
    window.location.href = `${API_URL}/github/install?user_code=${encodeURIComponent(code)}`;
  }

  if (state.kind === "done") {
    return (
      <>
        <PageHeader
          title={flow === "skill" ? "You're connected" : "Device activated"}
          subtitle={
            flow === "skill"
              ? "Your agent has your ingest key. Return to the terminal — we'll walk you through deploy and integrations from your dashboard once your first events arrive."
              : "You can close this tab and return to your terminal."
          }
        />
        <div className="flex items-center gap-2.5 rounded-[10px] border border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)] px-4 py-3">
          <span className="text-success">
            <CheckIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] text-fg">
            {flow === "skill" ? "Ingest key delivered to the agent." : "Device approved."}{" "}
            <span className="text-muted">You can close this tab.</span>
          </div>
        </div>
      </>
    );
  }

  if (state.kind === "step-done") {
    startSkillOnboarding();
    window.location.assign("/app");
    return null;
  }

  if (state.kind === "finalizing") {
    return (
      <>
        <PageHeader title="Finishing up…" subtitle="Wrapping up your activation." />
        <div
          className={`flex items-center gap-2.5 rounded-[10px] border border-dashed px-4 py-3 ${STRONG_LINE}`}
        >
          <span className="text-[#9aa3ff]">
            <SpinnerIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] text-muted">Finalizing your session…</div>
        </div>
      </>
    );
  }

  if (state.kind === "github") {
    return (
      <>
        <PageHeader
          title="Connect GitHub"
          subtitle="Let Superlog open a pull request when our fix agent has a patch. We'll only touch branches we create."
        />
        <Card>
          <div className="flex items-center gap-3">
            <span className="text-fg">
              <GithubIcon size={20} />
            </span>
            <div className="flex-1 text-[13px] text-muted">
              Optional — you can also do this later from settings.
            </div>
          </div>
        </Card>
        <div className={`mt-9 flex items-center justify-end gap-2 border-t pt-5 ${SOFT_LINE}`}>
          <button
            type="button"
            onClick={finalize}
            className="px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg"
          >
            Skip for now
          </button>
          <Btn
            variant="primary"
            size="md"
            onClick={connectGithub}
            className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
          >
            <GithubIcon size={13} />
            Connect GitHub
          </Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={flow === "skill" ? "Connect to Superlog" : "Approve linking this CLI session"}
        subtitle={
          flow === "skill" ? (
            <>
              Hit Approve to connect this project to Superlog. Check that the code matches the one
              your agent showed you.
            </>
          ) : (
            <>Confirm this is the code displayed in your CLI before approving.</>
          )
        }
      />
      <Card label={flow === "skill" ? "agent in your terminal" : "your cli"}>
        <div className="flex flex-col gap-4">
          <div
            className={`flex items-center justify-center rounded-[10px] border bg-[rgba(255,255,255,0.02)] py-4 font-mono text-[22px] tracking-[0.22em] text-fg ${STRONG_LINE}`}
          >
            {code}
          </div>
          {scope.needsPicker && <ScopePicker scope={scope} />}
          {state.kind === "error" && (
            <p className="m-0 text-[12.5px] text-danger">{state.message}</p>
          )}
        </div>
      </Card>
      <div className={`mt-9 flex items-center justify-end gap-2 border-t pt-5 ${SOFT_LINE}`}>
        <Btn
          variant="primary"
          size="md"
          loading={state.kind === "approving"}
          disabled={scope.busy || !scope.ready}
          onClick={approve}
          className="!h-[36px] !rounded-[8px] !px-[14px] !text-[13px]"
        >
          {state.kind === "approving" ? "Approving…" : "Approve"}
        </Btn>
      </div>
    </>
  );
}

type Scope = {
  busy: boolean;
  ready: boolean;
  needsPicker: boolean;
  selectedOrgId: string | null;
  selectedProjectId: string | null;
  orgs: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  setOrg: (orgId: string) => Promise<void>;
  setProject: (projectId: string) => void;
};

function useScopeSelection(): Scope {
  const qc = useQueryClient();
  const orgsQuery = useListOrganizations();
  const activeOrgQuery = useActiveOrganization();

  const orgs = useMemo(
    () =>
      (orgsQuery.data ?? [])
        .map((o) => ({ id: o.id, name: o.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [orgsQuery.data],
  );

  const selectedOrgId = activeOrgQuery.data?.id ?? null;

  const projectsQuery = useQuery({
    queryKey: ["org-projects", selectedOrgId ?? "none"],
    enabled: !activeOrgQuery.isPending,
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/org/projects`, { credentials: "include" });
      if (!res.ok) throw new Error(`failed to load projects (${res.status})`);
      return (await res.json()) as { projects: { id: string; name: string; slug: string }[] };
    },
  });
  const projects = projectsQuery.data?.projects ?? [];

  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (projects.length === 0) {
      setPickedProjectId(null);
      return;
    }
    if (!pickedProjectId || !projects.find((p) => p.id === pickedProjectId)) {
      setPickedProjectId(projects[0]?.id ?? null);
    }
  }, [projects, pickedProjectId]);

  const [switching, setSwitching] = useState(false);

  const setOrg = async (orgId: string) => {
    if (selectedOrgId === orgId) return;
    setSwitching(true);
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      await qc.invalidateQueries({ queryKey: ["org-projects"] });
    } finally {
      setSwitching(false);
    }
  };

  const busy =
    orgsQuery.isPending || activeOrgQuery.isPending || projectsQuery.isPending || switching;
  const ready = !busy && !!pickedProjectId;
  const needsPicker = !busy && (orgs.length > 1 || projects.length > 1);

  return {
    busy,
    ready,
    needsPicker,
    selectedOrgId,
    selectedProjectId: pickedProjectId,
    orgs,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    setOrg,
    setProject: setPickedProjectId,
  };
}

function ScopePicker({ scope }: { scope: Scope }) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3.5 py-3">
      <p className="m-0 text-[11px] uppercase tracking-[0.16em] text-subtle">scope</p>
      {scope.orgs.length > 1 && (
        <PickerRow label="Org">
          <ScopeSelect
            value={scope.selectedOrgId ?? ""}
            onChange={(v) => void scope.setOrg(v)}
            options={scope.orgs.map((o) => ({ value: o.id, label: o.name }))}
          />
        </PickerRow>
      )}
      {scope.projects.length > 1 && (
        <PickerRow label="Project">
          <ScopeSelect
            value={scope.selectedProjectId ?? ""}
            onChange={scope.setProject}
            options={scope.projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        </PickerRow>
      )}
    </div>
  );
}

function PickerRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[60px] text-[11.5px] text-muted">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function ScopeSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] px-2 text-[12.5px] text-fg focus:border-[rgba(255,255,255,0.25)] focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#0a0a0c] text-fg">
          {o.label}
        </option>
      ))}
    </select>
  );
}
