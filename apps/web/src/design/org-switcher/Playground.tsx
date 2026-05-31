import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "../scroll-area.tsx";

type MockOrg = { id: string; name: string; role: string };
type MockProject = { id: string; name: string; slug: string };

const MANY_ORGS: MockOrg[] = [
  { id: "personal", name: "Arseniy Shishaev", role: "Personal" },
  { id: "o1", name: "Acme Corp", role: "admin" },
  { id: "o2", name: "Beta Labs", role: "member" },
  { id: "o3", name: "Gamma Industries", role: "admin" },
  { id: "o4", name: "Delta Health", role: "member" },
  { id: "o5", name: "Epsilon Robotics", role: "admin" },
  { id: "o6", name: "Foxtrot Finance", role: "member" },
  { id: "o7", name: "Gravity Cloud", role: "admin" },
  { id: "o8", name: "Helix Bio", role: "member" },
  { id: "o9", name: "Iris AI", role: "admin" },
  { id: "o10", name: "Juno Logistics", role: "member" },
  { id: "o11", name: "Kepler Maps", role: "admin" },
  { id: "o12", name: "Lumen Media", role: "member" },
  { id: "o13", name: "Meridian Bank", role: "admin" },
  { id: "o14", name: "Nimbus Hosting", role: "member" },
  { id: "o15", name: "Orbital Games", role: "admin" },
];

const FEW_ORGS: MockOrg[] = MANY_ORGS.slice(0, 3);

const ORG_PROJECTS: Record<string, MockProject[]> = {
  personal: [{ id: "pp1", name: "Sandbox", slug: "sandbox" }],
  o1: [
    { id: "o1p1", name: "Production", slug: "production" },
    { id: "o1p2", name: "Staging", slug: "staging" },
    { id: "o1p3", name: "Edge — APAC", slug: "edge-apac" },
    { id: "o1p4", name: "Edge — EU", slug: "edge-eu" },
    { id: "o1p5", name: "Mobile iOS", slug: "mobile-ios" },
    { id: "o1p6", name: "Mobile Android", slug: "mobile-android" },
  ],
  o2: [{ id: "o2p1", name: "Production", slug: "production" }], // single — auto-skip
  o3: [
    { id: "o3p1", name: "Production", slug: "production" },
    { id: "o3p2", name: "Staging", slug: "staging" },
  ],
  o4: [{ id: "o4p1", name: "Production", slug: "production" }], // single
  o5: [
    { id: "o5p1", name: "Production", slug: "production" },
    { id: "o5p2", name: "Edge", slug: "edge" },
  ],
  o6: [{ id: "o6p1", name: "Production", slug: "production" }],
  o7: [
    { id: "o7p1", name: "Production", slug: "production" },
    { id: "o7p2", name: "Staging", slug: "staging" },
    { id: "o7p3", name: "Canary", slug: "canary" },
  ],
  o8: [{ id: "o8p1", name: "Production", slug: "production" }],
  o9: [
    { id: "o9p1", name: "Production", slug: "production" },
    { id: "o9p2", name: "Research", slug: "research" },
  ],
  o10: [{ id: "o10p1", name: "Production", slug: "production" }],
  o11: [{ id: "o11p1", name: "Production", slug: "production" }],
  o12: [
    { id: "o12p1", name: "Production", slug: "production" },
    { id: "o12p2", name: "Editorial", slug: "editorial" },
  ],
  o13: [{ id: "o13p1", name: "Production", slug: "production" }],
  o14: [
    { id: "o14p1", name: "Production", slug: "production" },
    { id: "o14p2", name: "Beta", slug: "beta" },
  ],
  o15: [{ id: "o15p1", name: "Production", slug: "production" }],
};

const ON_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

export function OrgSwitcherPlayground() {
  const [variant, setVariant] = useState<"many" | "few">("many");
  const orgs = variant === "many" ? MANY_ORGS : FEW_ORGS;

  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <a
              href="/design"
              className="text-[11px] uppercase tracking-[0.18em] text-subtle hover:text-fg"
            >
              ← Design
            </a>
            <h1 className="mt-2 text-[22px] font-semibold tracking-tight">Org switcher</h1>
            <p className="mt-1 text-[13px] text-muted">
              Press <Kbd>{ON_MAC ? "⌘" : "Ctrl"}</Kbd>+<Kbd>O</Kbd> to open. Pick an org, then a
              project. Single-project orgs commit immediately.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(["many", "few"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVariant(v)}
                className={`rounded-md border px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] ${
                  variant === v
                    ? "border-fg text-fg"
                    : "border-border text-muted hover:border-border-strong"
                }`}
              >
                {v === "many" ? "Many orgs" : "Few orgs"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl grid-cols-12 gap-8 px-6 py-12">
        <section className="col-span-12 md:col-span-7">
          <SectionLabel n="01">Live demo</SectionLabel>
          <p className="mt-2 text-[13px] text-muted">
            Click the trigger, or press <Kbd>{ON_MAC ? "⌘" : "Ctrl"}</Kbd>+<Kbd>O</Kbd>. Try
            picking <span className="text-fg">Acme Corp</span> (6 projects) vs{" "}
            <span className="text-fg">Beta Labs</span> (1 project, auto-skips).
          </p>
          <div className="mt-6 flex min-h-[440px] items-start justify-end rounded-md border border-border bg-surface-2 p-6">
            <FakeTrigger orgs={orgs} />
          </div>
        </section>

        <section className="col-span-12 md:col-span-5">
          <SectionLabel n="02">Step 1 — orgs</SectionLabel>
          <p className="mt-2 text-[13px] text-muted">Frozen, default state. No filter.</p>
          <div className="mt-6 rounded-md border border-border bg-surface-2 p-6">
            <div className="relative h-[440px]">
              <div className="absolute right-0 top-0 w-72">
                <SwitcherPanel
                  orgs={orgs}
                  activeOrgId="o1"
                  activeProjectId="o1p1"
                  staticView={{ step: "orgs", query: "" }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-12 md:col-span-7">
          <SectionLabel n="03">Step 1 — filtering</SectionLabel>
          <p className="mt-2 text-[13px] text-muted">
            Query "<span className="font-mono text-fg">cor</span>". The match is bolded inline —
            no background pill, so it doesn't fight the row's existing color contrast.
          </p>
          <div className="mt-6 rounded-md border border-border bg-surface-2 p-6">
            <div className="relative h-[360px]">
              <div className="absolute right-0 top-0 w-72">
                <SwitcherPanel
                  orgs={orgs}
                  activeOrgId="o1"
                  activeProjectId="o1p1"
                  staticView={{ step: "orgs", query: "cor" }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-12 md:col-span-5">
          <SectionLabel n="04">Step 2 — projects</SectionLabel>
          <p className="mt-2 text-[13px] text-muted">
            After picking Acme Corp. Back arrow returns to orgs.
          </p>
          <div className="mt-6 rounded-md border border-border bg-surface-2 p-6">
            <div className="relative h-[360px]">
              <div className="absolute right-0 top-0 w-72">
                <SwitcherPanel
                  orgs={orgs}
                  activeOrgId="o1"
                  activeProjectId="o1p1"
                  staticView={{ step: "projects", orgId: "o1", query: "" }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-12 md:col-span-7">
          <SectionLabel n="05">Empty</SectionLabel>
          <p className="mt-2 text-[13px] text-muted">No matches for the current query.</p>
          <div className="mt-6 rounded-md border border-border bg-surface-2 p-6">
            <div className="relative h-[280px]">
              <div className="absolute right-0 top-0 w-72">
                <SwitcherPanel
                  orgs={orgs}
                  activeOrgId="o1"
                  activeProjectId="o1p1"
                  staticView={{ step: "orgs", query: "zzzz" }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-12">
          <SectionLabel n="06">Notes</SectionLabel>
          <ul className="mt-4 space-y-2 text-[13px] text-muted">
            <li>
              <span className="text-fg">Flow.</span> Open → orgs list. Pick org → if it has one
              project, commit and close. If &gt;1, show project list with a back arrow.
            </li>
            <li>
              <span className="text-fg">Keybinding.</span>{" "}
              <Kbd>{ON_MAC ? "⌘" : "Ctrl"}</Kbd>+<Kbd>O</Kbd> opens the menu and steals the
              browser's "Open file" default via <span className="font-mono text-fg">preventDefault</span>. Linear / Notion override the same keys.
            </li>
            <li>
              <span className="text-fg">Match highlight.</span> Bold weight on the matched
              substring (no background fill), so it reads on both primary and secondary text.
            </li>
            <li>
              <span className="text-fg">Scrolling.</span> Both lists use Radix ScrollArea
              (already in <span className="font-mono text-fg">design/scroll-area.tsx</span>) so
              the scrollbar is thin and consistent across OSes.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}

function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-[11px] text-subtle">{n}</span>
      <h2 className="text-[14px] font-medium uppercase tracking-[0.12em] text-fg">{children}</h2>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg">
      {children}
    </kbd>
  );
}

type StaticView =
  | { step: "orgs"; query: string }
  | { step: "projects"; orgId: string; query: string };

function FakeTrigger({ orgs }: { orgs: MockOrg[] }) {
  const [open, setOpen] = useState(false);
  const [activeOrgId, setActiveOrgId] = useState("o1");
  const [activeProjectId, setActiveProjectId] = useState("o1p1");
  const ref = useRef<HTMLDivElement>(null);

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0];
  const activeProject = ORG_PROJECTS[activeOrgId]?.find((p) => p.id === activeProjectId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      const isModifier = ON_MAC ? e.metaKey : e.ctrlKey;
      if (!isModifier) return;
      if (e.key.toLowerCase() !== "o") return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 max-w-[260px] items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12px] text-fg transition-colors hover:border-border-strong"
      >
        <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-1 py-px font-mono text-[10px] leading-none text-subtle">
          <span>{ON_MAC ? "⌘" : "^"}</span>
          <span>O</span>
        </span>
        <span className="truncate text-muted">{activeOrg?.name}</span>
        <span className="text-subtle">/</span>
        <span className="truncate font-medium">{activeProject?.name ?? "—"}</span>
        <Chevron />
      </button>
      {open && (
        <SwitcherPanel
          orgs={orgs}
          activeOrgId={activeOrgId}
          activeProjectId={activeProjectId}
          onPickOrg={(id) => {
            const projects = ORG_PROJECTS[id] ?? [];
            if (projects.length === 1) {
              setActiveOrgId(id);
              setActiveProjectId(projects[0]!.id);
              setOpen(false);
            }
          }}
          onPickProject={(orgId, projectId) => {
            setActiveOrgId(orgId);
            setActiveProjectId(projectId);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SwitcherPanel({
  orgs,
  activeOrgId,
  activeProjectId,
  onPickOrg,
  onPickProject,
  onClose,
  staticView,
}: {
  orgs: MockOrg[];
  activeOrgId: string;
  activeProjectId: string;
  onPickOrg?: (id: string) => void;
  onPickProject?: (orgId: string, projectId: string) => void;
  onClose?: () => void;
  staticView?: StaticView;
}) {
  const isStatic = !!staticView;
  const [step, setStep] = useState<"orgs" | "projects">(staticView?.step ?? "orgs");
  const [drilledOrgId, setDrilledOrgId] = useState<string | null>(
    staticView?.step === "projects" ? staticView.orgId : null,
  );
  const [query, setQuery] = useState(staticView?.query ?? "");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isStatic) return;
    inputRef.current?.focus();
  }, [step, isStatic]);

  useEffect(() => setHighlight(0), [query, step]);

  const q = query.trim().toLowerCase();

  const matchedOrgs = useMemo(
    () => (q ? orgs.filter((o) => o.name.toLowerCase().includes(q)) : orgs),
    [orgs, q],
  );

  const currentOrgId = step === "projects" ? drilledOrgId : null;
  const projectsForStep = currentOrgId ? (ORG_PROJECTS[currentOrgId] ?? []) : [];
  const matchedProjects = useMemo(
    () =>
      q
        ? projectsForStep.filter(
            (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
          )
        : projectsForStep,
    [projectsForStep, q],
  );

  const drilledOrg = orgs.find((o) => o.id === currentOrgId);

  const pickOrg = (id: string) => {
    onPickOrg?.(id);
    if (isStatic) return;
    const projects = ORG_PROJECTS[id] ?? [];
    if (projects.length <= 1) return; // parent handles commit/close
    setDrilledOrgId(id);
    setStep("projects");
    setQuery("");
  };

  const goBack = () => {
    setStep("orgs");
    setDrilledOrgId(null);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isStatic) return;
    const list = step === "orgs" ? matchedOrgs : matchedProjects;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (step === "orgs") {
        const row = matchedOrgs[highlight];
        if (row) pickOrg(row.id);
      } else {
        const row = matchedProjects[highlight];
        if (row && currentOrgId) onPickProject?.(currentOrgId, row.id);
      }
    } else if (e.key === "Escape") {
      if (step === "projects") goBack();
      else onClose?.();
    } else if (e.key === "Backspace" && query === "" && step === "projects") {
      e.preventDefault();
      goBack();
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]">
      <div className="border-b border-border px-2.5 pb-2 pt-2.5">
        {step === "projects" && drilledOrg && (
          <button
            type="button"
            onClick={() => !isStatic && goBack()}
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-subtle hover:text-fg"
          >
            <BackArrow />
            <span className="truncate">{drilledOrg.name}</span>
          </button>
        )}
        <div className="relative">
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
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={step === "orgs" ? "Find org…" : "Find project…"}
            readOnly={isStatic}
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
              {matchedOrgs.map((o, i) => {
                const projectCount = (ORG_PROJECTS[o.id] ?? []).length;
                return (
                  <FilterRow
                    key={o.id}
                    active={o.id === activeOrgId}
                    highlighted={!isStatic && highlight === i}
                    onClick={() => pickOrg(o.id)}
                    primary={o.name}
                    secondary={o.role}
                    query={q}
                    trailing={
                      projectCount > 1 ? (
                        <span className="text-[10.5px] text-subtle">{projectCount}</span>
                      ) : null
                    }
                  />
                );
              })}
            </ul>
          </ScrollArea>
        )
      ) : matchedProjects.length === 0 ? (
        <Empty query={query} />
      ) : (
        <ScrollArea className="max-h-72">
          <ul>
            {matchedProjects.map((p, i) => (
              <FilterRow
                key={p.id}
                active={p.id === activeProjectId && currentOrgId === activeOrgId}
                highlighted={!isStatic && highlight === i}
                onClick={() => currentOrgId && onPickProject?.(currentOrgId, p.id)}
                primary={p.name}
                secondary={p.slug}
                query={q}
              />
            ))}
          </ul>
        </ScrollArea>
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

function Empty({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center text-[12px] text-subtle">
      No matches for "<span className="text-muted">{query}</span>"
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
  trailing,
}: {
  active: boolean;
  highlighted: boolean;
  onClick?: () => void;
  primary: string;
  secondary?: string;
  query: string;
  trailing?: React.ReactNode;
}) {
  return (
    <li>
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
        <div className="flex shrink-0 items-center gap-2">
          {trailing}
          {active && <Check />}
        </div>
      </button>
    </li>
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
