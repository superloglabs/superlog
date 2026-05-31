import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AdminOrgOverviewRow, useAdminOverview, useMe } from "./api.ts";
import { authClient } from "./auth-client.ts";

type Mode = "root" | "impersonate";

type Item = {
  id: string;
  label: string;
  sublabel?: string;
  group?: string;
  // Concatenated lowercase string of everything searchable.
  haystack: string;
  onSelect: () => void;
};

// Global open/close state, exposed via window so the cmd+k handler in App.tsx
// can poke it without lifting the palette out of its own file.
type PaletteAPI = { open: () => void; close: () => void; toggle: () => void };
declare global {
  // eslint-disable-next-line no-var
  var __superlogPalette: PaletteAPI | undefined;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("root");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const navigate = useNavigate();
  // Both isStaff and isImpersonating come from /api/me so they agree on the
  // current acting-as user. Reading impersonatedBy off the raw session object
  // would diverge from the staff check (which already runs against the
  // impersonated user's role).
  const me = useMe();
  const isStaff = me.data?.user.isStaff === true;
  const isImpersonating = me.data?.user.impersonating === true;

  // Only fetch the org overview when an admin actually opens the impersonate
  // sub-mode — non-admins never need it, and we don't want to hammer the
  // endpoint on every page load.
  const overview = useAdminOverview(open && mode === "impersonate" && isStaff);

  useEffect(() => {
    const api: PaletteAPI = {
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
    };
    globalThis.__superlogPalette = api;
    return () => {
      if (globalThis.__superlogPalette === api) globalThis.__superlogPalette = undefined;
    };
  }, []);

  // Reset to root mode + clear input on each open so the palette never opens
  // mid-sub-mode from a previous session.
  useEffect(() => {
    if (open) {
      setMode("root");
      setQuery("");
      setCursor(0);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [mode, query]);

  const items = useMemo<Item[]>(() => {
    if (mode === "root") {
      const navItems: Item[] = [
        { id: "nav-overview", label: "Overview", group: "Navigate", haystack: "overview home", onSelect: () => navigate("/") },
        { id: "nav-issues", label: "Issues", group: "Navigate", haystack: "issues incidents", onSelect: () => navigate("/incidents") },
        { id: "nav-alerts", label: "Alerts", group: "Navigate", haystack: "alerts", onSelect: () => navigate("/alerts") },
        { id: "nav-explore", label: "Explore", group: "Navigate", haystack: "explore traces logs metrics", onSelect: () => navigate("/explore") },
        { id: "nav-dashboards", label: "Dashboards", group: "Navigate", haystack: "dashboards", onSelect: () => navigate("/dashboards") },
        { id: "nav-settings", label: "Settings", group: "Navigate", haystack: "settings preferences", onSelect: () => navigate("/settings") },
      ];
      const adminItems: Item[] = isStaff
        ? [
            { id: "nav-admin", label: "Admin", group: "Admin", haystack: "admin staff", onSelect: () => navigate("/admin") },
            { id: "nav-evals", label: "Evals", group: "Admin", haystack: "evals", onSelect: () => navigate("/admin/evals") },
            {
              id: "impersonate",
              label: "Impersonate user…",
              sublabel: "Search by org or person",
              group: "Admin",
              haystack: "impersonate switch user org",
              onSelect: () => {
                setMode("impersonate");
                setQuery("");
              },
            },
          ]
        : [];
      const stopItem: Item[] = isImpersonating
        ? [
            {
              id: "stop-impersonating",
              label: "Stop impersonating",
              group: "Session",
              haystack: "stop impersonating exit",
              onSelect: async () => {
                // Better Auth surfaces failures in result.error rather than
                // throwing — bail without redirecting so the user gets some
                // signal (the bar stays up) instead of a no-op refresh.
                const result = await authClient.admin.stopImpersonating();
                if (result?.error) {
                  console.error("stopImpersonating failed", result.error);
                  return;
                }
                setOpen(false);
                window.location.assign("/");
              },
            },
          ]
        : [];
      return [...stopItem, ...navItems, ...adminItems];
    }

    // impersonate mode: one item per user, deduped across orgs. The admin is a
    // member of every org in this codebase, so a per-(user × org) list balloons
    // and makes "type the name" feel broken — the same handful of users repeat
    // across every org. Collapse to one row per user; show their org list as a
    // sublabel and pack name + email + every org name/slug into the haystack so
    // typing either a person or a company narrows correctly.
    const rows: AdminOrgOverviewRow[] = overview.data ?? [];
    const selfId = me.data?.user.id;
    const byUser = new Map<
      string,
      { email: string; name: string | null; orgs: string[]; slugs: string[] }
    >();
    for (const row of rows) {
      for (const m of row.members) {
        if (m.userId === selfId) continue;
        const existing = byUser.get(m.userId);
        if (existing) {
          existing.orgs.push(row.org.name);
          existing.slugs.push(row.org.slug);
        } else {
          byUser.set(m.userId, {
            email: m.email,
            name: m.name,
            orgs: [row.org.name],
            slugs: [row.org.slug],
          });
        }
      }
    }
    const out: Item[] = [];
    for (const [userId, info] of byUser) {
      const label = info.name ? `${info.name} · ${info.email}` : info.email;
      out.push({
        id: `imp-${userId}`,
        label,
        sublabel: info.orgs.join(", "),
        haystack: `${info.email} ${info.name ?? ""} ${info.orgs.join(" ")} ${info.slugs.join(" ")}`.toLowerCase(),
        onSelect: async () => {
          // Same pattern as stopImpersonating: error lands in result.error,
          // not as a throw. Don't reload if the impersonation didn't take.
          const result = await authClient.admin.impersonateUser({ userId });
          if (result?.error) {
            console.error("impersonateUser failed", result.error);
            return;
          }
          setOpen(false);
          // Hard reload so every query and the active-org cookie reflect the
          // new session.
          window.location.assign("/");
        },
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [mode, navigate, isStaff, isImpersonating, overview.data, me.data?.user.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => fuzzyMatch(it.haystack, q));
  }, [items, query]);

  // Keep cursor in range when the list shrinks.
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-bg/70 px-4 pt-[12vh] backdrop-blur-md"
      onClick={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCursor((c) => Math.min(filtered.length - 1, c + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setCursor((c) => Math.max(0, c - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const selected = filtered[cursor];
          if (selected) runSelect(selected);
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (mode !== "root") {
            setMode("root");
            setQuery("");
          } else {
            setOpen(false);
          }
        } else if (e.key === "Backspace" && query === "" && mode !== "root") {
          e.preventDefault();
          setMode("root");
        }
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          {mode === "impersonate" && (
            <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">
              Impersonate
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === "root" ? "Jump to…" : "Search users by email or org…"}
            className="flex-1 bg-transparent text-[14px] text-fg placeholder:text-subtle focus:outline-none"
            autoFocus
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">esc</span>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {mode === "impersonate" && overview.isLoading && (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">Loading users…</div>
          )}
          {filtered.length === 0 && !(mode === "impersonate" && overview.isLoading) && (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">No results.</div>
          )}
          {filtered.map((it, idx) => {
            const prevGroup = idx > 0 ? filtered[idx - 1]?.group : undefined;
            const showHeader = it.group && it.group !== prevGroup;
            return (
              <div key={it.id}>
                {showHeader && (
                  <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">
                    {it.group}
                  </div>
                )}
                <button
                  type="button"
                  data-idx={idx}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => runSelect(it)}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] ${
                    idx === cursor ? "bg-bg text-fg" : "text-muted"
                  }`}
                >
                  <span className="truncate">{it.label}</span>
                  {it.sublabel && (
                    <span className="ml-3 truncate font-mono text-[11px] text-subtle">
                      {it.sublabel}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Some onSelects (impersonate, stop-impersonating) are async; the Item type
// says `() => void` so the call sites would otherwise lose any rejection.
// Funnel everything through here so a network failure surfaces in the console
// instead of becoming an unhandled rejection.
function runSelect(item: Item) {
  try {
    const result = item.onSelect() as unknown;
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).catch((err) => {
        console.error("Command palette action failed", err);
      });
    }
  } catch (err) {
    console.error("Command palette action failed", err);
  }
}

// Substring match against the lowercase haystack. We tried subsequence first
// but it fired false positives like "im" matching Overview because its
// haystack is "overview home" — `i` in "overview" + `m` in "home" satisfies
// subsequence. Plain substring is stricter and lines up with how people
// actually type into palettes.
function fuzzyMatch(s: string, q: string): boolean {
  return s.includes(q);
}
