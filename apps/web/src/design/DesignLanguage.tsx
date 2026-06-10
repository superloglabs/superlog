import { type ReactNode, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import {
  ExploreTabsStatic,
  LogsTable,
  MetricLineChart,
  TimeseriesChart,
  TracesTable,
} from "../Explore.tsx";
import {
  IncidentDetailContent,
  IncidentRow,
  IssueDrawer,
  IssueRow,
  fmtRelative,
} from "../Issues.tsx";
import type { AgentRun, Incident, IncidentEvent, IncidentListItem, Issue } from "../api.ts";
import { AgentKeyStep } from "../onboarding/OnboardingWizard.tsx";
import { RANGE_PRESETS, RangePicker, type RangeSelection } from "./RangePicker.tsx";
import { OrgSwitcherPlayground } from "./org-switcher/Playground.tsx";
import { ServiceMapPlayground } from "./service-map/Playground.tsx";
import { SuperlogOnboardingPlayground } from "./superlog-onboarding/Playground.tsx";
import {
  Arrow,
  Btn,
  Chip,
  FieldLabel,
  Input,
  Label,
  MetricTile,
  SearchInput,
  Select,
  Sparkline,
  Tile,
  Wordmark,
} from "./ui.tsx";

// ---------------------------------------------------------------------------
// Design Language — /design
//
// Storybook for the primitives in ./ui.tsx. Black canvas · cobalt accent ·
// soft corners (10px controls, 10-12px cards) · bento grids. No deboss; flat
// hero; split nav.
// ---------------------------------------------------------------------------

export function DesignLanguage() {
  return (
    <Routes>
      <Route path="/design/explore" element={<ExplorePage />} />
      <Route path="/design/issues" element={<IssuesPage />} />
      <Route path="/design/onboarding" element={<SuperlogOnboardingPlayground />} />
      <Route path="/design/agent-congrats" element={<AgentCongratsPlayground />} />
      <Route path="/design/org-switcher" element={<OrgSwitcherPlayground />} />
      <Route path="/design/service-map" element={<ServiceMapPlayground />} />
      <Route path="*" element={<MainStorybook />} />
    </Routes>
  );
}

function AgentCongratsPlayground() {
  const [variant, setVariant] = useState<"ready" | "claiming" | "error">("ready");
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <div className="flex items-center justify-center gap-2 px-8 py-5">
        {(["ready", "claiming", "error"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVariant(v)}
            className={`rounded-md border px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] ${variant === v ? "border-fg text-fg" : "border-[rgba(255,255,255,0.12)] text-muted"}`}
          >
            {v}
          </button>
        ))}
      </div>
      <main className="flex justify-center px-8 pb-16 pt-6">
        <div className="w-full max-w-[640px]">
          <AgentKeyStep
            githubLabel="acme-org"
            slackLabel="Acme HQ"
            keyPrefix={variant === "ready" ? "sl_public_demo" : null}
            returnTo={null}
            claiming={variant === "claiming"}
            error={variant === "error" ? "Couldn't register the agent's key. Try again." : null}
            onDone={() => {}}
          />
        </div>
      </main>
    </div>
  );
}

function MainStorybook() {
  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <TopNav />

      <main className="relative">
        <Hero />

        <div className="mx-auto max-w-6xl px-6 pb-24">
          <Section id="color" n="01" title="Color" subtitle="Surfaces, ink, signal.">
            <ColorBento />
          </Section>

          <Section id="type" n="02" title="Typography" subtitle="Inter, tuned tight.">
            <TypeBento />
          </Section>

          <Section
            id="space"
            n="03"
            title="Space & Radius"
            subtitle="Eight-pixel rhythm. Soft radius."
          >
            <SpaceBento />
          </Section>

          <Section
            id="buttons"
            n="04"
            title="Buttons"
            subtitle="Primary, secondary, ghost, destructive."
          >
            <ButtonsBento />
          </Section>

          <Section id="inputs" n="05" title="Inputs" subtitle="Text, search, select, textarea.">
            <InputsBento />
          </Section>

          <Section
            id="chips"
            n="06"
            title="Chips & Status"
            subtitle="Observability-flavored labels."
          >
            <ChipsBento />
          </Section>

          <Section id="cards" n="07" title="Cards" subtitle="Metric, log row, issue.">
            <CardsBento />
          </Section>

          <Section
            id="signal"
            n="08"
            title="Signal"
            subtitle="A composed widget showing the parts together."
          >
            <SignalWidget />
          </Section>

          <Section id="pages" n="09" title="Pages" subtitle="Full-page compositions.">
            <PagesBento />
          </Section>

          <Footer />
        </div>
      </main>
    </div>
  );
}

function PagesBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <a
        href="/design/explore"
        className="col-span-12 block border border-border p-5 transition-colors hover:border-border-strong md:col-span-6"
      >
        <div className="flex items-baseline justify-between">
          <Label>logs · traces · metrics</Label>
          <Arrow />
        </div>
        <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-fg">Explore</h3>
        <p className="mt-1 text-[13px] text-muted">
          Filter bar, grouped timeseries, logs / traces / metrics list.
        </p>
      </a>
      <a
        href="/design/issues"
        className="col-span-12 block border border-border p-5 transition-colors hover:border-border-strong md:col-span-6"
      >
        <div className="flex items-baseline justify-between">
          <Label>list · detail · status</Label>
          <Arrow />
        </div>
        <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-fg">Issues</h3>
        <p className="mt-1 text-[13px] text-muted">
          Issue list with status tabs, row selection, and detail panel.
        </p>
      </a>
      <a
        href="/design/onboarding"
        className="col-span-12 block border border-border p-5 transition-colors hover:border-border-strong md:col-span-6"
      >
        <div className="flex items-baseline justify-between">
          <Label>setup · todos · dashboard</Label>
          <Arrow />
        </div>
        <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-fg">Onboarding</h3>
        <p className="mt-1 text-[13px] text-muted">
          Install → deploy, then a dashboard with todos for GitHub, Slack, and the MCP server.
        </p>
      </a>
      <a
        href="/design/org-switcher"
        className="col-span-12 block border border-border p-5 transition-colors hover:border-border-strong md:col-span-6"
      >
        <div className="flex items-baseline justify-between">
          <Label>search · keyboard · O</Label>
          <Arrow />
        </div>
        <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-fg">Org switcher</h3>
        <p className="mt-1 text-[13px] text-muted">
          Filterable org + project menu, opened with the O key.
        </p>
      </a>
      <a
        href="/design/service-map"
        className="col-span-12 block border border-border p-5 transition-colors hover:border-border-strong md:col-span-6"
      >
        <div className="flex items-baseline justify-between">
          <Label>canvas · groups · badges</Label>
          <Arrow />
        </div>
        <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-fg">Service map</h3>
        <p className="mt-1 text-[13px] text-muted">
          Dotted react-flow canvas with draggable services, grouped buckets, and cost / security /
          performance signal badges.
        </p>
      </a>
    </div>
  );
}

function ExplorePage() {
  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <SubpageNav crumb="Explore" />
      <main className="mx-auto max-w-6xl px-6 pb-24 pt-12">
        <ExploreBento />
        <Footer />
      </main>
    </div>
  );
}

function SubpageNav({ crumb }: { crumb: string }) {
  return (
    <header className="relative z-10">
      <div className="px-6">
        <nav className="flex items-center justify-start gap-3 py-5">
          <a
            href="/design"
            className="text-[14px] font-medium text-muted transition-opacity hover:text-fg"
          >
            ← Design
          </a>
          <span className="text-[14px] text-subtle">/</span>
          <span className="text-[14px] font-medium text-fg">{crumb}</span>
        </nav>
      </div>
      <div style={{ height: "0.5px", background: "rgba(255,255,255,0.07)" }} />
    </header>
  );
}

// ---------------------------------------------------------------------------
// Split floating nav — logo on left, items on right
// ---------------------------------------------------------------------------

const navItems = [
  { label: "Color", href: "#color" },
  { label: "Type", href: "#type" },
  { label: "Components", href: "#buttons" },
  { label: "Signal", href: "#signal" },
];

const sectionToNav: { id: string; href: string }[] = [
  { id: "color", href: "#color" },
  { id: "type", href: "#type" },
  { id: "buttons", href: "#buttons" },
  { id: "inputs", href: "#buttons" },
  { id: "chips", href: "#buttons" },
  { id: "cards", href: "#buttons" },
  { id: "signal", href: "#signal" },
];

function TopNav() {
  const [active, setActive] = useState<string>("#color");

  useEffect(() => {
    const update = () => {
      const y = window.scrollY + window.innerHeight * 0.35;
      let current = "#color";
      for (const m of sectionToNav) {
        const el = document.getElementById(m.id);
        if (el && el.offsetTop <= y) current = m.href;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header className="relative z-10">
      <div className="px-6">
        <nav className="flex items-center justify-start gap-10 py-5">
          {navItems.map((item) => {
            const isActive = active === item.href;
            return (
              <a
                key={item.href}
                href={item.href}
                className={`text-[14px] font-medium text-fg transition-opacity hover:opacity-70 ${
                  isActive ? "underline underline-offset-[6px] decoration-1" : ""
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
      </div>
      <div style={{ height: "0.5px", background: "rgba(255,255,255,0.07)" }} />
    </header>
  );
}

// ---------------------------------------------------------------------------
// Hero — flat, centered, no card
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section id="top" className="relative px-6 pb-20 pt-20 text-center">
      <span className="text-[13px] font-medium text-muted">House style</span>

      <h1
        className="mx-auto mt-6 max-w-3xl text-balance text-[2rem] leading-[1.02] tracking-tight text-fg md:text-[3rem]"
        style={{ fontWeight: 450 }}
      >
        Help agents
        <br />
        fix themselves.
      </h1>

      <div className="relative mx-auto mt-12 max-w-md">
        <img
          src="/rocket.png"
          alt=""
          aria-hidden="true"
          className="pointer-events-none w-full select-none"
          style={{
            mixBlendMode: "lighten",
            maskImage: "radial-gradient(ellipse at center, black 45%, transparent 85%)",
            WebkitMaskImage: "radial-gradient(ellipse at center, black 45%, transparent 85%)",
          }}
        />
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Btn variant="primary" size="lg">
          Deploy agent
        </Btn>
        <Btn variant="secondary" size="lg">
          Read the spec
          <Arrow />
        </Btn>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section shell — left-aligned title, bento grid below
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  n?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-24 scroll-mt-24">
      <header className="mb-6 flex items-baseline">
        <h2 className="pl-6 text-[28px] font-semibold tracking-tight text-fg md:text-[32px]">
          {title}
        </h2>
        <p className="pl-10 text-sm text-muted">{subtitle}</p>
      </header>
      <div>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 01 — Color bento
// ---------------------------------------------------------------------------

function ColorBento() {
  return (
    <div className="grid auto-rows-[minmax(0,_1fr)] grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-5 md:row-span-2" label="Accent">
        <div
          className="mb-4 h-48 w-full"
          style={{
            background: "#485AE2",
            boxShadow: "0 0 40px -6px rgba(72,90,226,0.46), inset 0 0 0 1px rgba(255,255,255,0.07)",
          }}
        />
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-sm font-medium text-fg">accent</span>
          <span className="font-mono text-[11px] tabular-nums text-subtle">#485AE2</span>
        </div>
        <p className="mt-1 text-[12px] text-muted">
          Primary action. Softened cobalt: bright enough to call attention while the softened dark
          surfaces keep the overall palette calmer.
        </p>
      </Tile>

      <Tile className="col-span-12 md:col-span-7" label="Surfaces">
        <div className="grid grid-cols-4 gap-2">
          {[
            { name: "bg", hex: "#141414" },
            { name: "surface", hex: "#1C1C1E" },
            { name: "surface-2", hex: "#232325" },
            { name: "surface-3", hex: "#2B2B2E" },
          ].map((s) => (
            <div key={s.name}>
              <div
                className="h-16 w-full"
                style={{
                  background: s.hex,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              />
              <div className="mt-2 font-mono text-[11px] text-fg">{s.name}</div>
              <div className="font-mono text-[10px] tabular-nums text-subtle">{s.hex}</div>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="col-span-6 md:col-span-4" label="Ink">
        <div className="space-y-2">
          {[
            { name: "fg", hex: "#F5F5F6", sample: "Primary" },
            { name: "muted", hex: "#8A8A8F", sample: "Secondary" },
            { name: "subtle", hex: "#676C75", sample: "Tertiary" },
          ].map((i) => (
            <div key={i.name} className="flex items-baseline justify-between">
              <span style={{ color: i.hex }} className="text-[13px] font-medium">
                {i.sample}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-subtle">
                {i.name} · {i.hex}
              </span>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="col-span-6 md:col-span-3" label="Signal">
        <div className="grid grid-cols-3 gap-2">
          {[
            { name: "success", hex: "#41D195" },
            { name: "warning", hex: "#E7B15A" },
            { name: "danger", hex: "#EF5A6F" },
          ].map((s) => (
            <div key={s.name} className="flex flex-col items-center gap-1.5">
              <div
                className="h-10 w-10"
                style={{
                  background: s.hex,
                  boxShadow: `0 0 16px -4px ${s.hex}88`,
                }}
              />
              <span className="font-mono text-[10px] text-muted">{s.name}</span>
            </div>
          ))}
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 02 — Typography bento
// ---------------------------------------------------------------------------

function TypeBento() {
  return (
    <div className="grid auto-rows-[minmax(0,_1fr)] grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-8" label="Display · 72/0.95/700">
        <div className="font-sans text-[72px] font-medium leading-[0.95] tracking-[-0.03em] text-fg">
          Signals in,
          <br />
          fixes out.
        </div>
      </Tile>

      <Tile className="col-span-12 md:col-span-4 md:row-span-2" label="Scale">
        <div className="space-y-3">
          {[
            { name: "display", size: 72, weight: 500 },
            { name: "h1", size: 48, weight: 600 },
            { name: "h2", size: 32, weight: 600 },
            { name: "h3", size: 22, weight: 600 },
            { name: "body", size: 15, weight: 400 },
            { name: "small", size: 13, weight: 400 },
            { name: "micro", size: 10, weight: 500 },
          ].map((t) => (
            <div
              key={t.name}
              className="flex items-baseline justify-between border-b border-border pb-2 last:border-0"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
                {t.name}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-subtle">
                {t.size}px · {t.weight}
              </span>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="col-span-12 md:col-span-4" label="Body · 15/1.5/400">
        <p className="text-[15px] leading-[1.5] text-fg">
          The quick brown fox jumps over the lazy dog, 0123456789. Used for paragraphs,
          descriptions, and list copy.
        </p>
      </Tile>

      <Tile className="col-span-6 md:col-span-2" label="Mono">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
          agent.running
        </span>
      </Tile>

      <Tile className="col-span-6 md:col-span-2" label="Numerals">
        <span className="font-sans text-4xl font-semibold tabular-nums text-fg">284ms</span>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 03 — Space & Radius bento
// ---------------------------------------------------------------------------

const spaceSteps = [4, 8, 12, 16, 24, 32, 48, 64];
// Mirrors the borderRadius scale in tailwind.config.ts — keep in sync.
const radiusSteps = [
  { name: "sm", px: 2 },
  { name: "base", px: 4 },
  { name: "md", px: 6 },
  { name: "lg", px: 10 },
  { name: "xl", px: 12 },
  { name: "2xl", px: 14 },
];

function SpaceBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-8" label="Spacing · 8-pixel grid">
        <div className="space-y-2.5">
          {spaceSteps.map((s) => (
            <div key={s} className="flex items-center gap-4">
              <span className="w-12 font-mono text-[11px] tabular-nums text-subtle">{s}px</span>
              <span className="h-2.5 bg-accent/70" style={{ width: `${s * 4}px` }} />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                space-{s}
              </span>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="col-span-12 md:col-span-4" label="Radius · soft">
        <div className="grid grid-cols-3 gap-3">
          {radiusSteps.map((r) => (
            <div key={r.name} className="flex flex-col items-center gap-2">
              <div
                className="h-14 w-14 bg-surface-3"
                style={{
                  borderRadius: `${r.px}px`,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                }}
              />
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                {r.name}
              </div>
              <div className="font-mono text-[10px] tabular-nums text-subtle">{r.px}px</div>
            </div>
          ))}
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 04 — Buttons bento
// ---------------------------------------------------------------------------

function ButtonsBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-7" label="Variants">
        <div className="flex flex-wrap gap-2.5">
          <Btn variant="primary">Deploy agent</Btn>
          <Btn variant="secondary">Preview</Btn>
          <Btn variant="ghost">Cancel</Btn>
          <Btn variant="danger">Delete project</Btn>
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-5" label="Sizes">
        <div className="flex flex-wrap items-center gap-2.5">
          <Btn size="sm">Small</Btn>
          <Btn>Medium</Btn>
          <Btn size="lg">Large</Btn>
        </div>
      </Tile>
      <Tile className="col-span-12" label="States">
        <div className="flex flex-wrap gap-2.5">
          <Btn>Default</Btn>
          <Btn className="outline outline-1 outline-offset-2 outline-accent">Focus</Btn>
          <Btn disabled>Disabled</Btn>
          <Btn loading>Loading</Btn>
          <Btn variant="primary">
            With icon
            <Arrow />
          </Btn>
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 05 — Inputs bento
// ---------------------------------------------------------------------------

function InputsBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-4" label="Text">
        <FieldLabel>Project name</FieldLabel>
        <Input placeholder="acme-prod" />
      </Tile>
      <Tile className="col-span-12 md:col-span-4" label="Search">
        <FieldLabel>Filter traces</FieldLabel>
        <SearchInput />
      </Tile>
      <Tile className="col-span-12 md:col-span-4" label="Select">
        <FieldLabel>Environment</FieldLabel>
        <Select options={["production", "staging", "preview"]} />
      </Tile>
      <Tile className="col-span-12" label="Textarea">
        <FieldLabel>Alert rule</FieldLabel>
        <textarea
          rows={4}
          defaultValue={'error.rate > 0.05 AND service.name == "checkout"'}
          className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
        />
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 06 — Chips bento
// ---------------------------------------------------------------------------

function ChipsBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-4" label="Status">
        <div className="flex flex-wrap gap-2">
          <Chip tone="success" dot>
            healthy
          </Chip>
          <Chip tone="warning" dot>
            degraded
          </Chip>
          <Chip tone="danger" dot>
            down
          </Chip>
          <Chip tone="muted" dot>
            unknown
          </Chip>
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-4" label="HTTP">
        <div className="flex flex-wrap gap-2">
          <Chip tone="success">200</Chip>
          <Chip tone="muted">304</Chip>
          <Chip tone="warning">429</Chip>
          <Chip tone="danger">500</Chip>
          <Chip tone="danger">503</Chip>
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-4" label="Accent">
        <div className="flex flex-wrap gap-2">
          <Chip tone="accent">agent.suggested</Chip>
          <Chip tone="accent">auto.patch</Chip>
        </div>
      </Tile>
      <Tile className="col-span-12" label="Spans">
        <div className="flex flex-wrap gap-2">
          <Chip>span.kind=server</Chip>
          <Chip>service.name=checkout</Chip>
          <Chip>env=prod</Chip>
          <Chip>http.status=500</Chip>
          <Chip tone="danger">error.type=TimeoutError</Chip>
          <Chip tone="accent">agent.suggested</Chip>
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 07 — Cards bento
// ---------------------------------------------------------------------------

function CardsBento() {
  return (
    <div className="grid auto-rows-[minmax(0,_1fr)] grid-cols-12 gap-3">
      <MetricTile
        className="col-span-12 md:col-span-3"
        label="p99 latency"
        value="284"
        unit="ms"
        delta={-12.4}
      />
      <MetricTile
        className="col-span-12 md:col-span-3"
        label="error rate"
        value="1.82"
        unit="%"
        delta={+0.31}
        invert
      />
      <MetricTile
        className="col-span-12 md:col-span-3"
        label="throughput"
        value="4.3k"
        unit="rps"
        delta={+8.2}
      />
      <IssueTile className="col-span-12 md:col-span-3 md:row-span-2" />
      <div className="col-span-12 md:col-span-9">
        <LogTile />
      </div>
    </div>
  );
}

function LogTile() {
  const rows = [
    { t: "14:02:17.482", lvl: "INFO", svc: "checkout", msg: "POST /api/charge 200 in 142ms" },
    { t: "14:02:17.501", lvl: "WARN", svc: "auth", msg: "jwt expiring in <60s, refreshing" },
    { t: "14:02:17.623", lvl: "INFO", svc: "checkout", msg: "POST /api/charge 200 in 118ms" },
    {
      t: "14:02:17.710",
      lvl: "ERROR",
      svc: "checkout",
      msg: "upstream timeout → stripe.charges.create",
    },
    { t: "14:02:17.812", lvl: "INFO", svc: "worker", msg: "fingerprint.hash=a3f91b issue.new" },
  ];
  const lvlTone: Record<string, string> = {
    INFO: "text-muted",
    WARN: "text-warning",
    ERROR: "text-danger",
  };
  return (
    <div className="h-full border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-success" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            live tail · last 500
          </span>
        </div>
        <span className="font-mono text-[10px] text-subtle">service:checkout,auth,worker</span>
      </div>
      <div className="divide-y divide-border/60 font-mono text-[11.5px] leading-relaxed">
        {rows.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-[auto_auto_auto_1fr] gap-3 px-4 py-2 hover:bg-surface-2"
          >
            <span className="tabular-nums text-subtle">{r.t}</span>
            <span className={`w-11 ${lvlTone[r.lvl]}`}>{r.lvl}</span>
            <span className="text-accent">{r.svc}</span>
            <span className="truncate text-fg">{r.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function IssueTile({ className = "" }: { className?: string }) {
  return (
    <div className={`relative border border-border p-5 ${className}`}>
      <div className="flex items-center justify-between">
        <Chip tone="danger" dot>
          open
        </Chip>
        <span className="font-mono text-[10px] text-subtle">ISS-0421</span>
      </div>
      <h3 className="mt-3 text-[15px] font-semibold tracking-tight text-fg">
        TimeoutError in <span className="font-mono text-accent">checkout</span>
      </h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Upstream <code className="font-mono text-fg">stripe.charges.create</code> exceeded 3000ms in
        8% of <code className="font-mono text-fg">us-east-1</code>.
      </p>
      <div className="mt-4 bg-accent-soft p-3">
        <div className="mb-1 flex items-center gap-2">
          <span className="h-1.5 w-1.5 bg-accent" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
            agent proposal
          </span>
        </div>
        <p className="text-[12.5px] text-muted">
          Bump <code className="font-mono">stripeClient.timeoutMs</code>{" "}
          <code className="font-mono">3000 → 8000</code> + retry w/ backoff.
        </p>
        <div className="mt-3 flex gap-2">
          <Btn size="sm">Review</Btn>
          <Btn size="sm" variant="ghost">
            Dismiss
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 08 — Signal widget
// ---------------------------------------------------------------------------

function SignalWidget() {
  return (
    <div className="border border-border">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Wordmark size="sm" />
          <span className="h-4 w-px bg-border-strong" />
          <span className="font-mono text-[11px] text-muted">
            acme-prod / <span className="text-fg">checkout</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="warning" dot>
            degraded
          </Chip>
          <Btn size="sm" variant="ghost">
            Open agent
          </Btn>
        </div>
      </div>
      <div className="grid grid-cols-12">
        <div className="col-span-12 border-b border-border p-5 md:col-span-8 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              latency · last 15m
            </span>
            <span className="font-mono text-[10px] text-subtle">p50 · p95 · p99</span>
          </div>
          <div className="mt-3">
            <Sparkline tone="danger" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 border-t border-border pt-4">
            <Stat label="p50" value="74ms" delta="+2" />
            <Stat label="p95" value="198ms" delta="+14" danger />
            <Stat label="p99" value="612ms" delta="+318" danger />
          </div>
        </div>
        <div className="col-span-12 p-5 md:col-span-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            active agents
          </span>
          <div className="mt-3 space-y-2">
            <AgentRow name="root-cause" status="running" />
            <AgentRow name="patch-proposal" status="queued" />
            <AgentRow name="regression-check" status="idle" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  delta,
  danger = false,
}: {
  label: string;
  value: string;
  delta: string;
  danger?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-sans text-lg font-semibold tabular-nums text-fg">{value}</span>
        <span
          className={`font-mono text-[10px] tabular-nums ${danger ? "text-danger" : "text-muted"}`}
        >
          {delta}
        </span>
      </div>
    </div>
  );
}

function AgentRow({ name, status }: { name: string; status: "running" | "queued" | "idle" }) {
  const tone = { running: "success", queued: "warning", idle: "muted" } as const;
  return (
    <div className="flex items-center justify-between border border-border bg-surface-2 px-2.5 py-1.5">
      <span className="font-mono text-[11.5px] text-fg">agent.{name}</span>
      <Chip tone={tone[status]} dot>
        {status}
      </Chip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issues page — /design/issues
// ---------------------------------------------------------------------------

const NOW = "2026-04-24T09:35:00.000Z";

const ISSUE_FIXTURES: Issue[] = [
  {
    id: "1",
    projectId: "p1",
    fingerprint: "abc123",
    kind: "span",
    service: "checkout-api",
    exceptionType: "TimeoutError",
    title: "stripe.charges.create exceeded timeout",
    message: "Request to Stripe took 3218ms, limit is 3000ms",
    topFrame:
      "at ChargeService.create (src/billing/charge.ts:84:11)\nat POST /api/checkout (src/routes/checkout.ts:42:5)",
    firstSeen: "2026-04-24T07:12:00.000Z",
    lastSeen: "2026-04-24T09:34:12.000Z",
    silencedAt: null,
    groupingState: "grouped",
    groupingSource: "heuristic",
    groupingReason: null,
    eventCount: 183,
    lastSample: {
      kind: "span",
      service: "checkout-api",
      severity: null,
      message: "Request to Stripe took 3218ms, limit is 3000ms",
      body: null,
      exceptionType: "TimeoutError",
      topFrame: "at ChargeService.create (src/billing/charge.ts:84:11)",
      normalizedFrames: [],
      stacktrace: null,
      seenAt: "2026-04-24T09:34:12.000Z",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "fedcba9876543210",
    },
    createdAt: "2026-04-24T07:12:00.000Z",
  },
  {
    id: "2",
    projectId: "p1",
    fingerprint: "def456",
    kind: "span",
    service: "cart-api",
    exceptionType: "TypeError",
    title: "Cannot read properties of undefined (reading 'price')",
    message: "item.variant is undefined when cart contains a deleted SKU",
    topFrame:
      "at CartService.total (src/cart/cart.ts:129:22)\nat GET /api/cart (src/routes/cart.ts:18:3)",
    firstSeen: "2026-04-24T08:03:44.000Z",
    lastSeen: "2026-04-24T09:31:55.000Z",
    silencedAt: null,
    groupingState: "grouped",
    groupingSource: "heuristic",
    groupingReason: null,
    eventCount: 41,
    lastSample: null,
    createdAt: "2026-04-24T08:03:44.000Z",
  },
  {
    id: "3",
    projectId: "p1",
    fingerprint: "ghi789",
    kind: "span",
    service: "payments-worker",
    exceptionType: "ConnectionError",
    title: "Redis connection refused",
    message: "ECONNREFUSED 127.0.0.1:6379",
    topFrame: "at RedisClient.connect (node_modules/ioredis/built/Redis.ts:213:9)",
    firstSeen: "2026-04-24T09:15:00.000Z",
    lastSeen: "2026-04-24T09:28:40.000Z",
    silencedAt: null,
    groupingState: "grouped",
    groupingSource: "heuristic",
    groupingReason: null,
    eventCount: 7,
    lastSample: null,
    createdAt: "2026-04-24T09:15:00.000Z",
  },
  {
    id: "4",
    projectId: "p1",
    fingerprint: "jkl012",
    kind: "span",
    service: "checkout-api",
    exceptionType: "ValidationError",
    title: "Invalid coupon code format",
    message: null,
    topFrame: null,
    firstSeen: "2026-04-23T14:00:00.000Z",
    lastSeen: "2026-04-23T17:42:18.000Z",
    silencedAt: null,
    groupingState: "grouped",
    groupingSource: "heuristic",
    groupingReason: null,
    eventCount: 512,
    lastSample: null,
    createdAt: "2026-04-23T14:00:00.000Z",
  },
];

type IssuesScenarioId =
  | "complete_findings"
  | "complete_pr"
  | "low_confidence"
  | "running"
  | "awaiting_human"
  | "failed";

type IssuesScenario = {
  id: IssuesScenarioId;
  label: string;
  agentRun: AgentRun | null;
  events: IncidentEvent[];
  incident: Incident;
};

function IssuesPage() {
  const [scenarioId, setScenarioId] = useState<IssuesScenarioId>("complete_findings");
  const [tab, setTab] = useState<"incidents" | "issues">("incidents");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scenario = ISSUES_SCENARIOS[scenarioId];

  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <SubpageNav crumb="Issues" />
      <ScenarioToolbar
        active={scenarioId}
        onChange={(id) => {
          setScenarioId(id);
          setSelectedId(null);
        }}
        options={Object.values(ISSUES_SCENARIOS).map((s) => ({
          id: s.id,
          label: s.label,
        }))}
      />
      <main className="mx-auto max-w-6xl px-6 pb-24 pt-8">
        <div className="mb-8">
          <Label>page</Label>
          <h1 className="mt-3 text-[32px] font-semibold tracking-tight text-fg">Issues</h1>
          <p className="mt-1 text-[13px] text-muted">
            Mock data · mirrors live route at <code>/issues</code>.
          </p>
        </div>

        <div className="mb-4 flex items-center gap-1 rounded-sm border border-border bg-surface-2 p-0.5 w-fit">
          {(["incidents", "issues"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setSelectedId(null);
              }}
              className={
                tab === t
                  ? "rounded-[2px] bg-surface-3 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-fg"
                  : "px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-muted hover:text-fg"
              }
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "incidents" ? (
          <IncidentsTabMock scenario={scenario} selectedId={selectedId} onSelect={setSelectedId} />
        ) : (
          <IssuesTabMock issues={ISSUE_FIXTURES} selectedId={selectedId} onSelect={setSelectedId} />
        )}

        <Footer />
      </main>
    </div>
  );
}

function ScenarioToolbar({
  active,
  onChange,
  options,
}: {
  active: IssuesScenarioId;
  onChange: (id: IssuesScenarioId) => void;
  options: { id: IssuesScenarioId; label: string }[];
}) {
  return (
    <div className="border-y border-accent/30 bg-accent-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
          scenario
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => onChange(o.id)}
              className={
                active === o.id
                  ? "rounded-sm bg-accent px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-accent-ink"
                  : "rounded-sm px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-accent hover:bg-accent/10"
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] text-accent/70">
          storybook · click a row to open the drawer
        </span>
      </div>
    </div>
  );
}

function IncidentsTabMock({
  scenario,
  selectedId,
  onSelect,
}: {
  scenario: IssuesScenario;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const fixtureBuckets = (counts: number[]) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return counts.map((count, i) => {
      const d = new Date(today.getTime() - (counts.length - 1 - i) * 86_400_000);
      return { day: d.toISOString().slice(0, 10), count };
    });
  };
  const incidents: IncidentListItem[] = [
    {
      incident: scenario.incident,
      agentRun: scenario.agentRun,
      windowDays: 14,
      buckets: fixtureBuckets([0, 0, 1, 2, 1, 3, 4, 5, 6, 8, 12, 14, 9, 11]),
      impactedUsers: 47,
      impactedUsersAvailable: true,
      impactedUsersCapped: false,
      pendingResolutionProposal: null,
    },
    {
      incident: {
        ...INCIDENT_FIXTURE,
        id: "inc-2",
        title: "Webhook delivery falling behind for tenant.eu",
        codename: "amber-pangolin",
        severity: "SEV-3",
        service: "webhook-dispatcher",
        issueCount: 1,
        status: "open",
      },
      agentRun: null,
      windowDays: 14,
      buckets: fixtureBuckets([1, 1, 0, 2, 1, 0, 1, 2, 3, 2, 4, 3, 5, 4]),
      impactedUsers: 0,
      impactedUsersAvailable: false,
      impactedUsersCapped: false,
      pendingResolutionProposal: null,
    },
  ];
  const selected = incidents.find((row) => row.incident.id === selectedId) ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-sm border border-border bg-surface-2 p-0.5">
          {["Open", "Resolved", "All"].map((label) => (
            <button
              key={label}
              className={
                label === "Open"
                  ? "rounded-[2px] bg-surface-3 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-fg"
                  : "px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-muted hover:text-fg"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <Label>{incidents.length} incidents</Label>
      </div>

      <div className="divide-y divide-border border border-border">
        {incidents.map((row) => (
          <IncidentRow
            key={row.incident.id}
            row={row}
            selected={selectedId === row.incident.id}
            onClick={() => onSelect(selectedId === row.incident.id ? null : row.incident.id)}
          />
        ))}
      </div>

      {selected && (
        <DrawerShell onClose={() => onSelect(null)}>
          <IncidentDetailContent
            incident={selected.incident}
            issues={INCIDENT_ISSUES_FIXTURE}
            agentRun={selected.agentRun}
            events={selected.agentRun ? scenario.events : []}
            eventsLoading={false}
            eventsError={null}
            onClose={() => onSelect(null)}
            onViewIssue={() => {}}
            onToggleStatus={() => {}}
            updatingIncident={false}
          />
        </DrawerShell>
      )}
    </div>
  );
}

function IssuesTabMock({
  issues,
  selectedId,
  onSelect,
}: {
  issues: Issue[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = issues.find((i) => i.id === selectedId) ?? null;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-sm border border-border bg-surface-2 p-0.5">
          {["Active", "Silenced", "All"].map((label) => (
            <button
              key={label}
              className={
                label === "Active"
                  ? "rounded-[2px] bg-surface-3 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-fg"
                  : "px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-muted hover:text-fg"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <Label>{issues.length} issues</Label>
      </div>

      <div className="divide-y divide-border border border-border">
        {issues.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            selected={selectedId === issue.id}
            onClick={() => onSelect(selectedId === issue.id ? null : issue.id)}
          />
        ))}
      </div>

      {selected && (
        <IssueDrawer
          issue={selected}
          onClose={() => onSelect(null)}
          onToggleSilence={() => {}}
          onOpenEvent={() => {}}
          silenceUpdating={false}
        />
      )}
    </div>
  );
}

function DrawerShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <div className="flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

const INCIDENT_FIXTURE: Incident = {
  id: "inc-1",
  projectId: "p1",
  service: "checkout-api",
  environment: "production",
  title: "checkout-api can't reach Stripe on the EU charge path",
  codename: "squishy-narwhal",
  severity: "SEV-2",
  status: "open",
  noiseReason: null,
  noiseResolvedAt: null,
  firstSeen: "2026-04-24T07:12:00.000Z",
  lastSeen: "2026-04-24T09:34:12.000Z",
  issueCount: 3,
  slackChannelId: null,
  slackThreadTs: null,
  agentSummary: null,
  rootCauseText: null,
  rootCauseConfidence: null,
  estimatedImpactText: null,
  estimatedImpactConfidence: null,
  suggestedSeverity: null,
  noiseClassification: null,
  resolutionClassification: null,
  findingsAgentRunId: null,
  createdAt: "2026-04-24T07:12:00.000Z",
  updatedAt: "2026-04-24T09:34:12.000Z",
};

const INCIDENT_ISSUES_FIXTURE: Issue[] = [
  ISSUE_FIXTURES[0]!,
  ISSUE_FIXTURES[1]!,
  ISSUE_FIXTURES[2]!,
];

const AGENT_RUN_FIXTURE: AgentRun = {
  id: "inv-1",
  incidentId: "inc-1",
  runtime: "2m 14s",
  state: "complete",
  providerSessionId: "sess-abc",
  selectedRepoFullName: "acme/checkout",
  selectedRepoUrl: "https://github.com/acme/checkout",
  selectedBaseBranch: "main",
  cumulativeRuntimeMinutes: 3,
  resumeCount: 0,
  startedAt: "2026-04-24T09:30:00.000Z",
  completedAt: null,
  failureReason: null,
  result: {
    state: "complete",
    summary: "EU charge requests to Stripe time out at 3s for ~8% of carts.",
    proposedTitle: "checkout-api can't reach Stripe on the EU charge path",
    severity: "SEV-2",
    rootCauseConfidence: "high",
    rootCause: {
      confidence: 9,
      text: [
        "The EU charge path still passes the legacy `expand=balance_transaction` parameter to Stripe. We removed it everywhere else in commit a3f91b4c2d, but the regional fork was missed. Stripe acknowledges the param adds ~1.4s on cold paths, which is enough to push us past our 3s client timeout under normal latency.",
        "",
        "**src/billing/charge.eu.ts:48-55**",
        "```ts",
        "// src/billing/charge.eu.ts",
        "const charge = await stripe.charges.create({",
        "  amount,",
        "  currency,",
        "  source,",
        "  expand: ['balance_transaction'],",
        "});",
        "```",
        "",
        "Compare with the cleaned-up US path:",
        "",
        "**src/billing/charge.ts:84-89**",
        "```ts",
        "// src/billing/charge.ts",
        "const charge = await stripe.charges.create({",
        "  amount,",
        "  currency,",
        "  source,",
        "});",
        "```",
        "",
        "Trace `0123456789abcdef0123456789abcdef` shows the offending request hitting 3218ms, with the Stripe `Server-Timing` header reporting `expand;dur=1402`. Linear PROD-2189 captures the same pattern observed last quarter.",
      ].join("\n"),
    },
    estimatedImpact: {
      confidence: 7,
      text: [
        'checkout-api owns the synchronous payment authorization step on the EU storefront. Failures here surface to the customer as a generic "payment failed" page and the cart is rolled back; users either retry (often successfully) or abandon.',
        "",
        "Affected volume in the last hour: ~183 timeouts against ~2.3k EU charges (8%). At an average order value of €72 this is ~€13k/hr of at-risk revenue, though retry funnels typically recover ~60% of these.",
      ].join("\n"),
    },
    linearTicket: {
      id: "PROD-2189",
      url: "https://linear.app/acme/issue/PROD-2189",
      createdByAgent: true,
    },
  },
  createdAt: "2026-04-24T09:30:00.000Z",
  updatedAt: "2026-04-24T09:34:00.000Z",
};

const INCIDENT_EVENTS_FIXTURE: IncidentEvent[] = [
  {
    id: "ev-1",
    agentRunId: "inv-1",
    kind: "agent_run_queued",
    summary: "Investigation queued from incident open.",
    detail: null,
    createdAt: "2026-04-24T09:30:00.000Z",
  },
  {
    id: "ev-2",
    agentRunId: "inv-1",
    kind: "repo_selected",
    summary: "Selected repo acme/checkout (base branch: main).",
    detail: null,
    createdAt: "2026-04-24T09:30:14.000Z",
  },
  {
    id: "ev-3",
    agentRunId: "inv-1",
    kind: "agent.thinking",
    summary:
      "The error pattern only fires on the EU charge path. Worth checking whether the legacy `expand` parameter is still set there — we removed it elsewhere in #1421 but I don't see a corresponding change in the regional fork.",
    detail: null,
    createdAt: "2026-04-24T09:31:02.000Z",
  },
  {
    id: "ev-4",
    agentRunId: "inv-1",
    kind: "agent.tool_use",
    summary: "grep for `expand=balance_transaction` in src/billing/**",
    detail: null,
    createdAt: "2026-04-24T09:31:08.000Z",
  },
  {
    id: "ev-5",
    agentRunId: "inv-1",
    kind: "agent.tool_result",
    summary:
      "src/billing/charge.ts:84  expand: ['balance_transaction']\nsrc/billing/charge.eu.ts:51  expand: ['balance_transaction']",
    detail: null,
    createdAt: "2026-04-24T09:31:09.000Z",
  },
  {
    id: "ev-6",
    agentRunId: "inv-1",
    kind: "agent.thinking",
    summary:
      "Confirmed. The EU path still passes the expand param. I'll prepare a patch that drops it on the EU branch and adds a regression test asserting the request payload no longer includes balance_transaction.",
    detail: null,
    createdAt: "2026-04-24T09:31:40.000Z",
  },
  {
    id: "ev-7",
    agentRunId: "inv-1",
    kind: "confidence_gate_passed",
    summary: "Confidence gate passed: patch validated against existing tests.",
    detail: null,
    createdAt: "2026-04-24T09:33:12.000Z",
  },
  {
    id: "ev-8",
    agentRunId: "inv-1",
    kind: "agent.message",
    summary:
      "Patch ready. Removed the `expand=balance_transaction` parameter from `chargeEU()` and added a contract test asserting the outgoing request shape. Validation suite passes locally.",
    detail: null,
    createdAt: "2026-04-24T09:34:00.000Z",
  },
];

const ISSUES_SCENARIOS: Record<IssuesScenarioId, IssuesScenario> = {
  complete_findings: {
    id: "complete_findings",
    label: "Complete · findings",
    incident: INCIDENT_FIXTURE,
    agentRun: AGENT_RUN_FIXTURE,
    events: INCIDENT_EVENTS_FIXTURE,
  },
  complete_pr: {
    id: "complete_pr",
    label: "Complete · PR opened",
    incident: INCIDENT_FIXTURE,
    agentRun: {
      ...AGENT_RUN_FIXTURE,
      state: "complete",
      completedAt: NOW,
      result: {
        ...AGENT_RUN_FIXTURE.result!,
        state: "complete",
        rootCauseConfidence: "high",
        pr: {
          selectedRepoFullName: "acme/checkout",
          branchName: "fix/stripe-eu-timeouts",
          baseBranch: "main",
          patch: "diff --git a/src/billing/charge.eu.ts b/src/billing/charge.eu.ts\n",
          validationPassed: true,
          validationCommands: ["rg -q 'expand: \\[' src/billing/charge.eu.ts || exit 0"],
          changedFiles: ["src/billing/charge.eu.ts", "src/billing/__tests__/charge.eu.test.ts"],
          openStatus: "opened",
          url: "https://github.com/acme/checkout/pull/1422",
        },
      },
    },
    events: INCIDENT_EVENTS_FIXTURE,
  },
  running: {
    id: "running",
    label: "Running",
    incident: INCIDENT_FIXTURE,
    agentRun: {
      ...AGENT_RUN_FIXTURE,
      state: "running",
      completedAt: null,
      result: null,
    },
    events: INCIDENT_EVENTS_FIXTURE.slice(0, 4),
  },
  low_confidence: {
    id: "low_confidence",
    label: "Low confidence",
    incident: {
      ...INCIDENT_FIXTURE,
      title: "payments-worker: Redis connection refused, source unclear",
      severity: "SEV-3",
      codename: "drifting-tapir",
    },
    agentRun: {
      ...AGENT_RUN_FIXTURE,
      result: {
        state: "complete",
        summary:
          "payments-worker is logging ECONNREFUSED to Redis intermittently; mechanism not yet confirmed.",
        proposedTitle: "payments-worker: Redis connection refused, source unclear",
        severity: "SEV-3",
        rootCauseConfidence: "low",
        rootCause: {
          confidence: 3,
          text: [
            "Likely cause: the worker pool is recycling connections faster than Redis can accept them, but I could not find the connection-pool config in the repo to confirm. The error originates from `ioredis` and only fires on cold worker pods, which suggests a startup race rather than a sustained outage.",
            "",
            "**apps/payments-worker/src/redis.ts:14-22**",
            "```ts",
            "// apps/payments-worker/src/redis.ts",
            "export const redis = new Redis(process.env.REDIS_URL!, {",
            "  retryStrategy: (times) => Math.min(times * 50, 2000),",
            "});",
            "```",
            "",
            "I did not find a circuit-breaker or pool-size override anywhere under `apps/payments-worker/`, so the default ioredis settings apply. Without telemetry on Redis-side connection counts I can't rule out the alternative hypothesis that Redis itself is at its `maxclients` cap.",
          ].join("\n"),
        },
        estimatedImpact: {
          confidence: 4,
          text: "Background worker only — no synchronous user impact. Failed jobs are retried by the worker; if the underlying Redis issue persists, queue depth will grow and refunds may lag SLA. Currently 7 failures observed in the last 14 minutes against an unknown total job volume.",
        },
      },
    },
    events: INCIDENT_EVENTS_FIXTURE.slice(0, 5),
  },
  awaiting_human: {
    id: "awaiting_human",
    label: "Awaiting human",
    incident: INCIDENT_FIXTURE,
    agentRun: {
      ...AGENT_RUN_FIXTURE,
      state: "awaiting_human",
      result: {
        state: "awaiting_human",
        summary:
          "I narrowed it to the EU charge path's expand parameter. Need confirmation on whether `balance_transaction` is required by any downstream consumer before I drop it.",
        question:
          "Does the billing-recon pipeline depend on the `balance_transaction` field being expanded inline on the EU charge response?",
      },
    },
    events: INCIDENT_EVENTS_FIXTURE.slice(0, 6),
  },
  failed: {
    id: "failed",
    label: "Failed",
    incident: INCIDENT_FIXTURE,
    agentRun: {
      ...AGENT_RUN_FIXTURE,
      state: "failed",
      failureReason:
        "Investigation stalled after exhausting the runtime budget without reaching a confidence gate.",
      result: null,
    },
    events: INCIDENT_EVENTS_FIXTURE.slice(0, 5),
  },
};

// ---------------------------------------------------------------------------
// Explore bento — mirrors /explore with static fixtures
// ---------------------------------------------------------------------------

type DemoSource = "logs" | "traces" | "metrics";

const DEMO_RANGE = {
  since: "2026-04-24T05:45:00.000Z",
  until: "2026-04-24T06:45:00.000Z",
};

function ExploreBento() {
  const [source, setSource] = useState<DemoSource>("logs");
  const [selection, setSelection] = useState<RangeSelection>(RANGE_PRESETS[1]!);
  const [groupBy, setGroupBy] = useState("service.name");
  const [metricName, setMetricName] = useState("system.cpu.usage");
  const [attrs, setAttrs] = useState([
    { key: "deployment.environment", value: "prod" },
    { key: "cloud.region", value: "us-east-1" },
  ]);

  const countSeries =
    groupBy === "service.name" ? EXPLORE_SERIES_BY_SERVICE : EXPLORE_SERIES_BY_ENV;
  const metricSeries =
    groupBy === "service.name" ? EXPLORE_METRIC_SERIES_BY_SERVICE : EXPLORE_METRIC_SERIES_FLAT;

  const rowCount =
    source === "logs"
      ? EXPLORE_LOG_ROWS.length
      : source === "traces"
        ? EXPLORE_TRACE_ROWS.length
        : EXPLORE_METRIC_ROWS.length;

  return (
    <div className="flex flex-col gap-6">
      {/* Header — title + time selector */}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Label>explore</Label>
          <h2 className="mt-3 text-[32px] font-semibold tracking-tight text-fg">{source}</h2>
          <p className="mt-1 text-[13px] text-muted">
            Static fixtures · live route lives at <code>/explore/{source}</code>.
          </p>
        </div>
        <RangePicker value={selection} range={DEMO_RANGE} onChange={setSelection} />
      </section>

      {/* Tabs */}
      <ExploreTabsStatic source={source} onChange={(s) => setSource(s as DemoSource)} />

      {source === "metrics" ? (
        <>
          {/* 1. Metric selector */}
          <Tile>
            <div className="flex items-center gap-3">
              <Label>metric</Label>
              {["system.cpu.usage", "http.requests.total", "db.connections.active"].map((m) => (
                <button key={m} onClick={() => setMetricName(m)}>
                  <Chip tone={metricName === m ? "accent" : "neutral"}>{m}</Chip>
                </button>
              ))}
            </div>
          </Tile>

          {/* 2. Filters + group by */}
          <Tile>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label>filters</Label>
                {attrs.map((a, i) => (
                  <button
                    key={`${a.key}=${a.value}`}
                    onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}
                  >
                    <Chip tone="accent">
                      <span className="opacity-70">{a.key}</span>=<span>{a.value}</span>
                      <span className="ml-1 opacity-60">×</span>
                    </Chip>
                  </button>
                ))}
                <Btn variant="secondary" size="sm">
                  + add filter
                </Btn>
              </div>
              <div className="flex items-center gap-2">
                <Label>group by</Label>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="h-8 appearance-none rounded-sm border border-border bg-surface-2 pl-2.5 pr-7 font-mono text-[12px] text-fg focus:border-border-strong focus:outline-none"
                >
                  <option value="">none</option>
                  <option value="service.name">service.name</option>
                  <option value="deployment.environment">deployment.environment</option>
                </select>
                <span className="font-mono text-[10px] text-subtle">step 1 minute</span>
              </div>
            </div>
          </Tile>

          {/* 3. Chart */}
          <Tile>
            <MetricLineChart rows={metricSeries} />
          </Tile>
        </>
      ) : (
        <>
          {/* Chart (thin reference for logs/traces) */}
          <Tile>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Label>chart</Label>
              <div className="flex items-center gap-2">
                <Label>group by</Label>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="h-8 appearance-none rounded-sm border border-border bg-surface-2 pl-2.5 pr-7 font-mono text-[12px] text-fg focus:border-border-strong focus:outline-none"
                >
                  <option value="">none</option>
                  <option value="service.name">service.name</option>
                  <option value="deployment.environment">deployment.environment</option>
                </select>
                <span className="font-mono text-[10px] text-subtle">step 1 minute</span>
              </div>
            </div>
            <div className="opacity-50">
              <TimeseriesChart rows={countSeries} height={72} />
            </div>
          </Tile>

          {/* List with embedded filters on top */}
          <Tile padded={false}>
            <div className="border-b border-border px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label>filters</Label>
                {attrs.map((a, i) => (
                  <button
                    key={`${a.key}=${a.value}`}
                    onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}
                  >
                    <Chip tone="accent">
                      <span className="opacity-70">{a.key}</span>=<span>{a.value}</span>
                      <span className="ml-1 opacity-60">×</span>
                    </Chip>
                  </button>
                ))}
                <Btn variant="secondary" size="sm">
                  + add filter
                </Btn>
              </div>
            </div>
            <div className="overflow-auto">
              {source === "logs" ? (
                <LogsTable rows={EXPLORE_LOG_ROWS} />
              ) : (
                <TracesTable rows={EXPLORE_TRACE_ROWS} />
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border px-5 py-3">
              <span className="font-mono text-[11px] text-subtle">
                showing {rowCount} (limit 100)
              </span>
              <Btn variant="secondary" size="sm">
                load more
              </Btn>
            </div>
          </Tile>
        </>
      )}
    </div>
  );
}

const EXPLORE_SERIES_BY_SERVICE = (() => {
  const services = ["checkout-api", "cart-api", "payments-worker"];
  const out: { bucket: string; group: string; count: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const bucket = new Date(Date.UTC(2026, 3, 23, 20, 16 + i))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    for (const s of services) {
      const base = s === "checkout-api" ? 12 : s === "cart-api" ? 7 : 3;
      out.push({ bucket, group: s, count: base + Math.floor(Math.sin(i / 3 + base) * 4 + 4) });
    }
  }
  return out;
})();

const EXPLORE_SERIES_BY_ENV = (() => {
  const envs = ["prod", "staging"];
  const out: { bucket: string; group: string; count: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const bucket = new Date(Date.UTC(2026, 3, 23, 20, 16 + i))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    for (const e of envs) {
      const base = e === "prod" ? 20 : 4;
      out.push({ bucket, group: e, count: base + Math.floor(Math.sin(i / 4) * 5 + 5) });
    }
  }
  return out;
})();

const EXPLORE_LOG_ROWS = [
  {
    timestamp: "2026-04-23 20:45:02.114",
    service: "checkout-api",
    severity: "ERROR",
    body: "failed to connect to redis: ECONNREFUSED 127.0.0.1:6379",
    trace_id: "a3f1c7d9e4b2f803a1b6c5d4e3f2a1b0",
    span_id: "b7e8f9a0c1d2e3f4",
    severity_number: 17,
    log_attrs: {},
    resource_attrs: {},
  },
  {
    timestamp: "2026-04-23 20:44:58.801",
    service: "cart-api",
    severity: "WARN",
    body: "rate limit approaching for tenant acme-corp (917/1000)",
    trace_id: "c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9",
    span_id: "a1b2c3d4e5f6a7b8",
    severity_number: 13,
    log_attrs: {},
    resource_attrs: {},
  },
  {
    timestamp: "2026-04-23 20:44:51.322",
    service: "payments-worker",
    severity: "INFO",
    body: "stripe webhook received: payment_intent.succeeded",
    trace_id: "d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2",
    span_id: "e1f2a3b4c5d6e7f8",
    severity_number: 9,
    log_attrs: {},
    resource_attrs: {},
  },
  {
    timestamp: "2026-04-23 20:44:44.012",
    service: "checkout-api",
    severity: "INFO",
    body: "order persisted order_id=01JC7P3H8Q user_id=42",
    trace_id: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6",
    span_id: "c1d2e3f4a5b6c7d8",
    severity_number: 9,
    log_attrs: {},
    resource_attrs: {},
  },
  {
    timestamp: "2026-04-23 20:44:38.661",
    service: "cart-api",
    severity: "DEBUG",
    body: "cache miss for key user:42",
    trace_id: "f1e2d3c4b5a6978869584736251403f2",
    span_id: "8877665544332211",
    severity_number: 5,
    log_attrs: {},
    resource_attrs: {},
  },
];

const EXPLORE_METRIC_SERIES_BY_SERVICE = (() => {
  const services = [
    { name: "checkout-api", base: 58 },
    { name: "cart-api", base: 34 },
    { name: "payments-worker", base: 19 },
  ];
  const out: { bucket: string; group: string; value: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const bucket = new Date(Date.UTC(2026, 3, 24, 5, 46 + i))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    for (const s of services) {
      out.push({
        bucket,
        group: s.name,
        value: Math.round((s.base + Math.sin(i / 4 + s.base) * 10) * 10) / 10,
      });
    }
  }
  return out;
})();

const EXPLORE_METRIC_SERIES_FLAT = (() => {
  const out: { bucket: string; group: string; value: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const bucket = new Date(Date.UTC(2026, 3, 24, 5, 46 + i))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    out.push({ bucket, group: "", value: Math.round((42 + Math.sin(i / 3) * 15) * 10) / 10 });
  }
  return out;
})();

const EXPLORE_METRIC_ROWS = [
  {
    timestamp: "2026-04-24 06:44:02.114",
    kind: "gauge",
    metric_name: "system.cpu.usage",
    unit: "1",
    service: "checkout-api",
    value: 72.4,
    count: null,
  },
  {
    timestamp: "2026-04-24 06:44:01.801",
    kind: "gauge",
    metric_name: "system.cpu.usage",
    unit: "1",
    service: "cart-api",
    value: 38.1,
    count: null,
  },
  {
    timestamp: "2026-04-24 06:44:01.322",
    kind: "sum",
    metric_name: "http.requests.total",
    unit: "requests",
    service: "checkout-api",
    value: 1842,
    count: null,
  },
  {
    timestamp: "2026-04-24 06:44:00.012",
    kind: "gauge",
    metric_name: "db.connections.active",
    unit: "connections",
    service: "checkout-api",
    value: 12,
    count: null,
  },
  {
    timestamp: "2026-04-24 06:43:59.661",
    kind: "sum",
    metric_name: "http.requests.total",
    unit: "requests",
    service: "cart-api",
    value: 974,
    count: null,
  },
  {
    timestamp: "2026-04-24 06:43:59.100",
    kind: "gauge",
    metric_name: "system.memory.usage",
    unit: "By",
    service: "payments-worker",
    value: 83_886_080,
    count: null,
  },
];

const EXPLORE_TRACE_ROWS = [
  {
    timestamp: "2026-04-23 20:45:04.221",
    service: "checkout-api",
    span_name: "POST /api/checkout",
    status_code: "STATUS_CODE_ERROR",
    duration_ms: 812.44,
    trace_id: "a3f1c7d9e4b2f803a1b6c5d4e3f2a1b0",
    span_id: "b7e8f9a0c1d2e3f4",
    parent_span_id: "",
    span_kind: "SERVER",
    status_message: "redis unavailable",
  },
  {
    timestamp: "2026-04-23 20:44:58.009",
    service: "cart-api",
    span_name: "GET /api/cart",
    status_code: "STATUS_CODE_OK",
    duration_ms: 42.18,
    trace_id: "c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9",
    span_id: "a1b2c3d4e5f6a7b8",
    parent_span_id: "",
    span_kind: "SERVER",
    status_message: "",
  },
  {
    timestamp: "2026-04-23 20:44:51.707",
    service: "payments-worker",
    span_name: "charge.capture",
    status_code: "STATUS_CODE_OK",
    duration_ms: 318.77,
    trace_id: "d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2",
    span_id: "e1f2a3b4c5d6e7f8",
    parent_span_id: "",
    span_kind: "INTERNAL",
    status_message: "",
  },
  {
    timestamp: "2026-04-23 20:44:44.488",
    service: "checkout-api",
    span_name: "db.query orders",
    status_code: "STATUS_CODE_OK",
    duration_ms: 58.02,
    trace_id: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6",
    span_id: "c1d2e3f4a5b6c7d8",
    parent_span_id: "f7e8d9c0b1a29384",
    span_kind: "CLIENT",
    status_message: "",
  },
];

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <footer className="mt-24 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">
        <span>superlog · design language · v0.4 · 2026.04</span>
        <span className="tabular-nums">{now.toISOString().slice(11, 19)}z</span>
        <Label>built on the commute, refined over coffee</Label>
      </div>
    </footer>
  );
}
