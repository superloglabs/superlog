import type { Icon } from "@phosphor-icons/react";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { BugIcon } from "@phosphor-icons/react/dist/csr/Bug";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SirenIcon } from "@phosphor-icons/react/dist/csr/Siren";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Wordmark } from "./ui.tsx";

type NavigationItem = {
  href: string;
  label: string;
  icon: Icon;
  match?: string[];
};

const NAVIGATION_GROUPS: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: SquaresFourIcon },
      { href: "/incidents", label: "Incidents", icon: SirenIcon },
      { href: "/issues", label: "Errors", icon: BugIcon },
      { href: "/alerts", label: "Alerts", icon: BellIcon },
    ],
  },
  {
    label: "Observe",
    items: [
      { href: "/explore", label: "Explore", icon: MagnifyingGlassIcon },
      { href: "/dashboards", label: "Dashboards", icon: ChartBarIcon },
    ],
  },
];

const SETTINGS_ITEM: NavigationItem = { href: "/settings", label: "Settings", icon: GearIcon };

export function ProductShell({
  toolbar,
  children,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const current = [...NAVIGATION_GROUPS.flatMap((group) => group.items), SETTINGS_ITEM].find(
    (item) => isActive(item, pathname),
  );

  return (
    <div className="flex min-h-0 flex-1 bg-bg font-sans text-fg" data-product-shell>
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-surface/55 px-4 py-5 backdrop-blur md:flex">
        <div className="px-2">
          <Wordmark size="sm" />
        </div>

        <nav aria-label="Primary navigation" className="mt-9 space-y-7">
          {NAVIGATION_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-2 text-[11px] font-medium text-subtle">{group.label}</div>
              <div className="mt-2 space-y-0.5">
                {group.items.map((item) => (
                  <NavigationLink key={item.href} item={item} pathname={pathname} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-border pt-3">
          <NavigationLink item={SETTINGS_ITEM} pathname={pathname} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur-md">
          <div className="flex h-14 items-center justify-between gap-4 px-5 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <span className="shrink-0 md:hidden">
                <Wordmark size="sm" />
              </span>
              <span className="hidden text-[12px] text-muted md:inline">Workspace</span>
              <span className="hidden text-[12px] text-subtle md:inline">/</span>
              <span className="truncate text-[12px] text-fg">{current?.label ?? "Overview"}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">{toolbar}</div>
          </div>
          <MobileNavigation pathname={pathname} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

function NavigationLink({ item, pathname }: { item: NavigationItem; pathname: string }) {
  const active = isActive(item, pathname);
  const Icon = item.icon;
  return (
    <Link
      to={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
        active ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      <Icon size={17} weight="regular" className="shrink-0" aria-hidden />
      <span>{item.label}</span>
    </Link>
  );
}

function MobileNavigation({ pathname }: { pathname: string }) {
  const items = [...NAVIGATION_GROUPS.flatMap((group) => group.items), SETTINGS_ITEM];
  return (
    <nav
      aria-label="Mobile navigation"
      className="overflow-x-auto border-t border-border px-3 md:hidden"
    >
      <div className="flex min-w-max items-center gap-1 py-2">
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <Link
              key={item.href}
              to={item.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-2.5 py-1 text-[12px] ${
                active ? "bg-surface-3 text-fg" : "text-muted"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function isActive(item: NavigationItem, pathname: string) {
  if (item.href === "/") return pathname === "/" || pathname === "";
  return (
    pathname.startsWith(item.href) || item.match?.some((prefix) => pathname.startsWith(prefix))
  );
}
