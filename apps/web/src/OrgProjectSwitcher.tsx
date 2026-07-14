import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  type Me,
  useFetcher,
  useMe,
  useOrgProjects,
  useSetActiveProject,
  useSetFavoriteProject,
} from "./api.ts";
import { authClient, useActiveOrganization, useListOrganizations } from "./auth-client.ts";
import { ScrollArea } from "./design/scroll-area.tsx";
import { appPathFromProjectRoute, canonicalProjectLocation } from "./project-route.ts";

const ON_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

type MeWithOrg = Me & { org: NonNullable<Me["org"]>; project: NonNullable<Me["project"]> };

export function OrgProjectSwitcher() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const canOpen = !!me.data?.org && !!me.data?.project;

  // Global ⌘O / Ctrl+O toggles the menu.
  useEffect(() => {
    if (!canOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const modifier = ON_MAC ? e.metaKey : e.ctrlKey;
      if (!modifier || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "o") return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canOpen]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!me.data) {
    return <div className="h-7 w-44 animate-pulse rounded-md border border-border bg-surface-2" />;
  }
  // Pre-org user (mid-onboarding): no org/project to switch between yet.
  if (!me.data.org || !me.data.project) return null;
  const meData: MeWithOrg = { ...me.data, org: me.data.org, project: me.data.project };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 max-w-[300px] items-center gap-2 rounded-md border border-border px-2.5 text-[12px] text-fg transition-colors hover:border-border-strong"
      >
        <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-1 py-px font-mono text-[10px] leading-none text-subtle">
          <span>{ON_MAC ? "⌘" : "^"}</span>
          <span>O</span>
        </span>
        <span className="truncate text-muted">{meData.org.name}</span>
        <span className="text-subtle">/</span>
        <span className="truncate font-medium">{meData.project.name}</span>
        <Chevron />
      </button>
      {open && <SwitcherDropdown me={meData} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Step = "orgs" | "projects";

function SwitcherDropdown({ me, onClose }: { me: MeWithOrg; onClose: () => void }) {
  const orgsQuery = useListOrganizations();
  const activeOrgQuery = useActiveOrganization();
  const projects = useOrgProjects();
  const setActiveProject = useSetActiveProject();
  const setFavoriteProject = useSetFavoriteProject();
  const fetcher = useFetcher();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>("orgs");
  const [pendingOrgSwitch, setPendingOrgSwitch] = useState<{
    targetOrgId: string;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    setHighlight(0);
  }, [query, step]);

  const activeOrgId = activeOrgQuery.data?.id ?? me.org.id;
  const activeOrgSlug = orgsQuery.data?.find((org) => org.id === activeOrgId)?.slug ?? me.org.slug;

  const navigateToProject = useCallback(
    (projectSlug: string) => {
      navigate(
        canonicalProjectLocation(
          { orgSlug: activeOrgSlug, projectSlug },
          {
            pathname: appPathFromProjectRoute(location.pathname),
            search: location.search,
            hash: location.hash,
          },
        ),
        { replace: true },
      );
    },
    [activeOrgSlug, location.hash, location.pathname, location.search, navigate],
  );

  // Drilling into the *current* org's project list. This only runs for a
  // same-org click (switchOrgAndDrill sets pendingOrgSwitch only then), so the
  // active org and its projects are already loaded and the dropdown stays
  // mounted. A different-org switch is handled entirely in switchOrgAndDrill
  // because that path tears this component down (see below).
  useEffect(() => {
    if (!pendingOrgSwitch) return;
    if (activeOrgId !== pendingOrgSwitch.targetOrgId) return;
    if (projects.isFetching || !projects.data) return;
    const list = projects.data.projects;
    setPendingOrgSwitch(null);
    if (list.length <= 1) {
      const project = list[0];
      if (project) navigateToProject(project.slug);
      onClose();
    } else {
      setStep("projects");
      setQuery("");
    }
  }, [
    pendingOrgSwitch,
    activeOrgId,
    projects.isFetching,
    projects.data,
    navigateToProject,
    onClose,
  ]);

  const switchOrgAndDrill = async (orgId: string) => {
    // Clicking the current org just drills into its project list — no session
    // change, so the dropdown stays mounted and the effect above takes over.
    if (activeOrgId === orgId) {
      setPendingOrgSwitch({ targetOrgId: orgId });
      return;
    }
    // Switching to a *different* org is URL-first and deliberately does NOT
    // touch the session here. We resolve the target org's canonical route (its
    // slug + a project slug) from a read-only endpoint, then navigate there.
    // ProjectRouteBoundary then sees the new URL against the still-current
    // session and switches the active org to match the URL — its normal,
    // revert-free reconciliation (the same path used when a scoped URL is
    // opened directly).
    //
    // The tempting shortcut — call setActive first, then navigate — is racy:
    // setActive moves the session to the new org (and trips ActiveOrgSync's
    // queryClient.clear()) before the URL catches up, and in that window the
    // boundary sees new-org `me` on the old URL and reconciles *backwards*,
    // reverting the switch. Not switching the session until the URL leads
    // removes that window entirely.
    try {
      const route = await fetcher<{ orgSlug: string; projectSlug: string }>(
        `/api/me/org-route?orgId=${encodeURIComponent(orgId)}`,
      );
      navigate(
        canonicalProjectLocation(
          { orgSlug: route.orgSlug, projectSlug: route.projectSlug },
          {
            pathname: appPathFromProjectRoute(location.pathname),
            search: location.search,
            hash: location.hash,
          },
        ),
        { replace: true },
      );
    } catch {
      // Best effort: if route resolution fails, leave the user where they are.
    }
    onClose();
  };

  const manageOrg = async (orgId: string) => {
    if (activeOrgId !== orgId) {
      await authClient.organization.setActive({ organizationId: orgId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["me"] }),
        qc.invalidateQueries({ queryKey: ["org-projects"] }),
      ]);
    }
    onClose();
    navigate("/settings?scope=org&section=members");
  };

  const pickProject = async (projectId: string) => {
    const project = projects.data?.projects.find((candidate) => candidate.id === projectId);
    if (projectId === me.project.id) {
      if (project) navigateToProject(project.slug);
      onClose();
      return;
    }
    await setActiveProject.mutateAsync(projectId);
    if (project) navigateToProject(project.slug);
    onClose();
  };

  // The favorite is per-user-global (one project, in one org). It's only the
  // "favorite" for rows in the org it belongs to. Clicking the ★ pins this
  // project (server also pins the active org); clicking the filled ★ clears it.
  const favoriteProjectId =
    me.favorite?.orgId === activeOrgId ? (me.favorite?.projectId ?? null) : null;
  const toggleFavorite = (projectId: string) => {
    void setFavoriteProject.mutateAsync(projectId === favoriteProjectId ? null : projectId);
  };

  const goBackToOrgs = () => {
    setStep("orgs");
    setQuery("");
    setPendingOrgSwitch(null);
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(me.project.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  type OrgRow = { id: string; name: string; sub: string; active: boolean };
  const orgRows: OrgRow[] = useMemo(() => {
    const orgs = orgsQuery.data ?? [];
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      sub: o.slug,
      active: activeOrgId === o.id,
    }));
  }, [orgsQuery.data, activeOrgId]);

  const q = query.trim().toLowerCase();

  const matchedOrgs = useMemo(
    () => (q ? orgRows.filter((o) => o.name.toLowerCase().includes(q)) : orgRows),
    [orgRows, q],
  );

  const projectList = projects.data?.projects ?? [
    { id: me.project.id, name: me.project.name, slug: me.project.slug },
  ];
  const matchedProjects = useMemo(
    () =>
      q
        ? projectList.filter(
            (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
          )
        : projectList,
    [projectList, q],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (step === "orgs") {
      const list = matchedOrgs;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = list[highlight];
        if (row) void switchOrgAndDrill(row.id);
      }
    } else {
      const list = matchedProjects;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = list[highlight];
        if (row) void pickProject(row.id);
      } else if (e.key === "Backspace" && query === "") {
        e.preventDefault();
        goBackToOrgs();
      } else if (e.key === "Escape") {
        e.preventDefault();
        goBackToOrgs();
      }
    }
  };

  const isSwitching = !!pendingOrgSwitch;
  const drilledHeader = step === "projects" ? me.org.name : null;

  return (
    <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]">
      <div className="border-b border-border px-2.5 pb-2 pt-2.5">
        {drilledHeader && (
          <button
            type="button"
            onClick={goBackToOrgs}
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-subtle hover:text-fg"
          >
            <BackArrow />
            <span className="truncate">{drilledHeader}</span>
          </button>
        )}
        <div className="relative">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={step === "orgs" ? "Find organization…" : "Find project…"}
            className="h-7 w-full rounded-sm border border-border bg-surface-2 pl-7 pr-2 text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
      </div>

      {step === "orgs" ? (
        matchedOrgs.length === 0 ? (
          <Empty query={query} />
        ) : (
          <ScrollArea className="max-h-72">
            <ul>
              {matchedOrgs.map((o, i) => (
                <FilterRow
                  key={o.id}
                  active={o.active}
                  highlighted={highlight === i}
                  onClick={() => void switchOrgAndDrill(o.id)}
                  primary={o.name}
                  secondary={o.sub}
                  query={q}
                  onManage={() => void manageOrg(o.id)}
                />
              ))}
            </ul>
          </ScrollArea>
        )
      ) : isSwitching ? (
        <div className="px-3 py-6 text-center text-[12px] text-subtle">Loading projects…</div>
      ) : matchedProjects.length === 0 ? (
        <Empty query={query} />
      ) : (
        <>
          <ScrollArea className="max-h-72">
            <ul>
              {matchedProjects.map((p, i) => (
                <FilterRow
                  key={p.id}
                  active={p.id === me.project.id}
                  highlighted={highlight === i}
                  onClick={() => void pickProject(p.id)}
                  primary={p.name}
                  secondary={p.slug}
                  query={q}
                  isFavorite={p.id === favoriteProjectId}
                  onToggleFavorite={() => toggleFavorite(p.id)}
                />
              ))}
            </ul>
          </ScrollArea>
          <div className="h-px bg-border" />
          <div className="px-3 py-2.5">
            <div className="text-[11px] font-medium text-subtle">Project ID</div>
            <button
              type="button"
              onClick={copyId}
              className="mt-1 flex w-full items-center justify-between gap-2 text-left font-mono text-[11px] tabular-nums text-muted hover:text-fg"
            >
              <span className="truncate">{me.project.id}</span>
              <span className="shrink-0 font-sans text-[11px] text-subtle">
                {copied ? "Copied" : "Copy"}
              </span>
            </button>
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-2 px-3 py-1.5 text-[10px] text-subtle">
        <div className="flex items-center gap-2">
          <KbdMini>↑↓</KbdMini>
          <span>Navigate</span>
          <KbdMini>↵</KbdMini>
          <span>{step === "orgs" ? "Open" : "Select"}</span>
        </div>
        <div className="flex items-center gap-1">
          <KbdMini>Esc</KbdMini>
          <span>{step === "projects" ? "Back" : "Close"}</span>
        </div>
      </div>
    </div>
  );
}

function FilterRow({
  active,
  highlighted,
  onClick,
  primary,
  secondary,
  query,
  onManage,
  isFavorite,
  onToggleFavorite,
}: {
  active: boolean;
  highlighted: boolean;
  onClick: () => void;
  primary: string;
  secondary?: string;
  query: string;
  onManage?: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
}) {
  const hasTrailingAction = !!onManage || !!onToggleFavorite;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] ${
          highlighted ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-fg">{highlightMatch(primary, query)}</div>
          {secondary && (
            <div className="truncate text-[11px] text-subtle">
              {highlightMatch(secondary, query)}
            </div>
          )}
        </div>
        {active && !hasTrailingAction && <Check />}
      </button>
      {hasTrailingAction && (
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5">
          {active && <Check />}
          {onToggleFavorite && (
            <button
              type="button"
              aria-label={isFavorite ? `Unpin ${primary} as default` : `Pin ${primary} as default`}
              aria-pressed={isFavorite}
              title={isFavorite ? "Default project — click to unpin" : "Set as default project"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              className={`pointer-events-auto flex h-6 w-6 items-center justify-center rounded-sm transition hover:bg-surface-3 hover:text-fg focus:opacity-100 ${
                isFavorite
                  ? "text-accent opacity-100"
                  : "text-subtle opacity-0 group-hover:opacity-100"
              }`}
            >
              <StarIcon filled={!!isFavorite} />
            </button>
          )}
          {onManage && (
            <button
              type="button"
              aria-label={`Manage ${primary}`}
              title="Manage organization"
              onClick={(e) => {
                e.stopPropagation();
                onManage();
              }}
              className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-sm text-subtle opacity-0 transition hover:bg-surface-3 hover:text-fg focus:opacity-100 group-hover:opacity-100"
            >
              <GearIcon />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 17.3 6.2 20.6l1.1-6.5L2.5 9.5l6.5-1L12 2.6l3 5.9 6.5 1-4.8 4.6 1.1 6.5z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-fg">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

function Empty({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center text-[12px] text-subtle">
      No matches for "<span className="text-muted">{query}</span>"
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function KbdMini({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-border bg-surface px-1 py-px font-mono text-[10px] text-muted">
      {children}
    </span>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="shrink-0 text-subtle"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function BackArrow() {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-accent"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
