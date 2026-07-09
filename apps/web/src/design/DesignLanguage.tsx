import { type ReactNode, useState } from "react";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import {
  Btn,
  Chip,
  OutOfCreditsBadge,
  OutOfCreditsBanner,
  Tabs,
  ThemeToggle,
  Tile,
  Wordmark,
} from "./ui.tsx";

// ---------------------------------------------------------------------------
// Design Language — /design
//
// The living design sheet: a focused catalog of the canonical primitives and
// tokens. Cobalt accent · soft corners · eight-pixel rhythm · capitalized sans
// labels (no mono caps). Each section renders one component family straight from
// the shared home (ui.tsx / Dropdown.tsx) so the page and the app can't drift.
//
// This page is paired with the written contract in apps/web/DESIGN.md — change a
// primitive or token and you MUST update both the component and its panel here.
// Keep it lean: a component catalog, not a page gallery.
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: "tokens", label: "Tokens" },
  { id: "card", label: "Card" },
  { id: "buttons", label: "Buttons" },
  { id: "dropdowns", label: "Dropdowns" },
  { id: "tabs", label: "Tabs" },
  { id: "chips", label: "Chips" },
  { id: "callouts", label: "Callouts" },
];

export function DesignLanguage() {
  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <TopNav />
      <main className="mx-auto max-w-6xl px-6 pb-32">
        <Hero />

        <Section id="tokens" title="Tokens" subtitle="Color, type, space & radius.">
          <ColorBento />
          <div className="mt-3">
            <TypeBento />
          </div>
          <div className="mt-3">
            <SpaceBento />
          </div>
        </Section>

        <Section id="card" title="Card" subtitle="Surface, border, metric.">
          <CardBento />
        </Section>

        <Section id="buttons" title="Buttons" subtitle="Primary, secondary, ghost, danger.">
          <ButtonsBento />
        </Section>

        <Section id="dropdowns" title="Dropdowns" subtitle="Themed single-select menu.">
          <DropdownsBento />
        </Section>

        <Section id="tabs" title="Tabs" subtitle="Segmented view switch.">
          <TabsBento />
        </Section>

        <Section
          id="chips"
          title="Chips"
          subtitle="Fully-rounded sans pills; six tones, or a bare dot + label for status."
        >
          <ChipsBento />
        </Section>

        <Section
          id="callouts"
          title="Callouts"
          subtitle="Out-of-credits status chip & banner."
        >
          <CalloutsBento />
        </Section>

        <Footer />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared label helpers — capitalized sans, never mono caps
// ---------------------------------------------------------------------------

function PanelLabel({ children }: { children: ReactNode }) {
  return <div className="mb-4 text-[13px] font-medium text-muted">{children}</div>;
}

function FieldName({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[13px] font-medium text-muted">{children}</div>;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function TopNav() {
  return (
    <header className="sticky top-0 z-10 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <Wordmark size="sm" />
          <span className="h-4 w-px bg-border-strong" />
          <span className="text-[13px] font-medium text-muted">Design system</span>
        </div>
        <nav className="hidden items-center gap-7 md:flex">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="text-[13px] font-medium text-muted transition-colors hover:text-fg"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <ThemeToggle />
      </div>
      <div className="h-px bg-border" />
    </header>
  );
}

function Hero() {
  return (
    <section className="py-20 text-center">
      <span className="text-[13px] font-medium tracking-tight text-accent">House style</span>
      <h1
        className="mx-auto mt-5 max-w-2xl text-balance text-[2.25rem] leading-[1.02] tracking-tight text-fg md:text-[3rem]"
        style={{ fontWeight: 460 }}
      >
        Canonical components,
        <br />
        one source of truth.
      </h1>
      <p className="mx-auto mt-5 max-w-md text-[14px] leading-relaxed text-muted">
        Every primitive on this page is imported from the same modules the product ships — change it
        here and it changes everywhere.
      </p>
    </section>
  );
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-24 scroll-mt-24">
      <header className="mb-6 flex items-baseline gap-4">
        <h2 className="text-[26px] font-semibold tracking-tight text-fg md:text-[30px]">{title}</h2>
        <p className="text-[13px] text-muted">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-28 flex items-center justify-between border-t border-border pt-6">
      <span className="text-[13px] text-subtle">Superlog · Design language</span>
      <span className="text-[13px] text-subtle">Sourced from ui.tsx and Dropdown.tsx</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// 01 — Tokens
// ---------------------------------------------------------------------------

function Swatch({ name, hex, className }: { name: string; hex: string; className: string }) {
  return (
    <div>
      <div
        className={`h-14 w-full rounded-md ${className}`}
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)" }}
      />
      <div className="mt-2 text-[13px] font-medium text-fg">{name}</div>
      <div className="font-mono text-[11px] tabular-nums text-subtle">{hex}</div>
    </div>
  );
}

function ColorBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-5">
        <PanelLabel>Accent</PanelLabel>
        <div
          className="h-24 w-full rounded-md bg-accent"
          style={{ boxShadow: "0 0 40px -8px rgba(72,90,226,0.5)" }}
        />
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-fg">Accent</span>
          <span className="font-mono text-[11px] tabular-nums text-subtle">#485AE2</span>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          The single action color. One intense moment against calm surfaces.
        </p>
      </Tile>

      <Tile className="col-span-12 md:col-span-7">
        <PanelLabel>Surfaces</PanelLabel>
        <div className="grid grid-cols-4 gap-2">
          <Swatch name="Background" hex="#141414" className="bg-bg" />
          <Swatch name="Surface" hex="#1C1C1E" className="bg-surface" />
          <Swatch name="Surface 2" hex="#232325" className="bg-surface-2" />
          <Swatch name="Surface 3" hex="#2B2B2E" className="bg-surface-3" />
        </div>
      </Tile>

      <Tile className="col-span-12 md:col-span-7">
        <PanelLabel>Ink</PanelLabel>
        <div className="space-y-2.5">
          {[
            { name: "Primary", hex: "#F5F5F6", cls: "text-fg" },
            { name: "Secondary", hex: "#8A8A8F", cls: "text-muted" },
            { name: "Tertiary", hex: "#5A5A60", cls: "text-subtle" },
          ].map((i) => (
            <div key={i.name} className="flex items-baseline justify-between">
              <span className={`text-[15px] font-medium ${i.cls}`}>{i.name} text</span>
              <span className="font-mono text-[11px] tabular-nums text-subtle">{i.hex}</span>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="col-span-12 md:col-span-5">
        <PanelLabel>Signal</PanelLabel>
        <div className="grid grid-cols-3 gap-3">
          <Swatch name="Success" hex="#41D195" className="bg-success" />
          <Swatch name="Warning" hex="#E7B15A" className="bg-warning" />
          <Swatch name="Danger" hex="#EF5A6F" className="bg-danger" />
        </div>
      </Tile>
    </div>
  );
}

function TypeBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-8">
        <PanelLabel>Display · Inter</PanelLabel>
        <div className="text-[64px] font-medium leading-[0.95] tracking-tightest text-fg">
          Signals in,
          <br />
          fixes out.
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Scale</PanelLabel>
        <div className="space-y-2.5">
          {[
            { name: "Display", size: 64, weight: 500 },
            { name: "Heading 1", size: 30, weight: 600 },
            { name: "Heading 2", size: 20, weight: 600 },
            { name: "Body", size: 14, weight: 400 },
            { name: "Small", size: 12, weight: 400 },
            { name: "Mono", size: 11, weight: 500 },
          ].map((t) => (
            <div
              key={t.name}
              className="flex items-baseline justify-between border-b border-border pb-2 last:border-0"
            >
              <span className="text-[13px] text-muted">{t.name}</span>
              <span className="font-mono text-[11px] tabular-nums text-subtle">
                {t.size}px · {t.weight}
              </span>
            </div>
          ))}
        </div>
      </Tile>
    </div>
  );
}

const spaceSteps = [4, 8, 12, 16, 24, 32, 48, 64];
// Mirrors the borderRadius scale in tailwind.config.ts — keep in sync.
const radiusSteps = [
  { name: "Small", px: 2 },
  { name: "Base", px: 4 },
  { name: "Medium", px: 6 },
  { name: "Large", px: 10 },
  { name: "XL", px: 12 },
  { name: "2XL", px: 14 },
];

function SpaceBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-8">
        <PanelLabel>Spacing · 8-pixel grid</PanelLabel>
        <div className="space-y-2.5">
          {spaceSteps.map((s) => (
            <div key={s} className="flex items-center gap-4">
              <span className="w-10 font-mono text-[11px] tabular-nums text-subtle">{s}px</span>
              <span className="h-2.5 rounded-sm bg-accent/70" style={{ width: `${s * 4}px` }} />
            </div>
          ))}
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Radius</PanelLabel>
        <div className="grid grid-cols-3 gap-3">
          {radiusSteps.map((r) => (
            <div key={r.name} className="flex flex-col items-center gap-2">
              <div
                className="h-12 w-12 bg-surface-3"
                style={{
                  borderRadius: `${r.px}px`,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                }}
              />
              <div className="text-[12px] text-muted">{r.name}</div>
              <div className="font-mono text-[11px] tabular-nums text-subtle">{r.px}px</div>
            </div>
          ))}
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 02 — Card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  unit,
  className = "",
}: {
  label: string;
  value: string;
  unit: string;
  className?: string;
}) {
  return (
    <Tile className={className}>
      <span className="text-[13px] font-medium text-muted">{label}</span>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tabular-nums tracking-tight text-fg">{value}</span>
        <span className="text-[12px] text-subtle">{unit}</span>
      </div>
    </Tile>
  );
}

function CardBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-6">
        <PanelLabel>Content card</PanelLabel>
        <h3 className="text-[16px] font-semibold tracking-tight text-fg">Checkout latency</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          A plain <code className="font-mono text-fg">Tile</code> — bordered surface, soft radius,
          consistent padding. Compose anything inside it.
        </p>
        <div className="mt-4 flex gap-2">
          <Btn size="sm">Open</Btn>
          <Btn size="sm" variant="ghost">
            Dismiss
          </Btn>
        </div>
      </Tile>
      <StatCard className="col-span-6 md:col-span-3" label="p99 latency" value="284" unit="ms" />
      <StatCard className="col-span-6 md:col-span-3" label="Error rate" value="1.82" unit="%" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 03 — Buttons
// ---------------------------------------------------------------------------

function ButtonsBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-7">
        <PanelLabel>Variants</PanelLabel>
        <div className="flex flex-wrap gap-2.5">
          <Btn variant="primary">Deploy agent</Btn>
          <Btn variant="secondary">Preview</Btn>
          <Btn variant="ghost">Cancel</Btn>
          <Btn variant="danger">Delete project</Btn>
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-5">
        <PanelLabel>Sizes</PanelLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <Btn size="sm">Small</Btn>
          <Btn>Medium</Btn>
          <Btn size="lg">Large</Btn>
        </div>
      </Tile>
      <Tile className="col-span-12">
        <PanelLabel>States</PanelLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <Btn>Default</Btn>
          <Btn disabled>Disabled</Btn>
          <Btn loading>Loading</Btn>
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 04 — Dropdowns
// ---------------------------------------------------------------------------

const ENV_OPTIONS: DropdownOption[] = [
  { value: "production", label: "production" },
  { value: "staging", label: "staging" },
  { value: "preview", label: "preview" },
];

const SERVICE_OPTIONS: DropdownOption[] = [
  { value: "checkout-api", label: "checkout-api" },
  { value: "cart-api", label: "cart-api" },
  { value: "payments-worker", label: "payments-worker" },
  { value: "auth", label: "auth" },
  { value: "webhook-dispatcher", label: "webhook-dispatcher" },
];

function DropdownsBento() {
  const [env, setEnv] = useState("production");
  const [service, setService] = useState("checkout-api");
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Short list</PanelLabel>
        <FieldName>Environment</FieldName>
        <Dropdown value={env} onChange={setEnv} options={ENV_OPTIONS} searchable={false} />
      </Tile>
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Searchable</PanelLabel>
        <FieldName>Service</FieldName>
        <Dropdown value={service} onChange={setService} options={SERVICE_OPTIONS} />
      </Tile>
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Disabled</PanelLabel>
        <FieldName>Region</FieldName>
        <Dropdown
          value="us-east-1"
          onChange={() => {}}
          options={[{ value: "us-east-1", label: "us-east-1" }]}
          disabled
        />
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 05 — Tabs
// ---------------------------------------------------------------------------

type TabKey = "open" | "resolved" | "noise" | "all";

const TAB_LABELS: Record<TabKey, string> = {
  open: "Open",
  resolved: "Resolved",
  noise: "Noise",
  all: "All",
};

const TAB_COPY: Record<TabKey, string> = {
  open: "Active incidents that still need attention.",
  resolved: "Incidents an agent or human has already closed out.",
  noise: "Low-signal incidents auto-classified as noise, still counted.",
  all: "Every incident regardless of its current status.",
};

function TabsBento() {
  const [tab, setTab] = useState<TabKey>("open");
  const [size, setSize] = useState<"sm" | "md">("md");
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-8">
        <PanelLabel>View switch</PanelLabel>
        <Tabs
          value={tab}
          onChange={setTab}
          size={size}
          options={(Object.keys(TAB_LABELS) as TabKey[]).map((k) => ({
            value: k,
            label: TAB_LABELS[k],
          }))}
        />
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-4">
          <span className="text-[13px] font-medium text-accent">{TAB_LABELS[tab]}</span>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg">{TAB_COPY[tab]}</p>
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Size</PanelLabel>
        <div className="flex flex-col items-start gap-4">
          <Tabs
            value={size}
            onChange={(v) => setSize(v)}
            options={[
              { value: "md", label: "Medium" },
              { value: "sm", label: "Small" },
            ]}
          />
          <span className="text-[13px] text-muted">Controls the switch on the left.</span>
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 06 — Chips
// ---------------------------------------------------------------------------

function ChipsBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-7">
        <PanelLabel>Tones</PanelLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <Chip tone="neutral">neutral</Chip>
          <Chip tone="accent">accent</Chip>
          <Chip tone="success">success</Chip>
          <Chip tone="warning">warning</Chip>
          <Chip tone="danger">danger</Chip>
          <Chip tone="muted">muted</Chip>
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-5">
        <PanelLabel>With status dot</PanelLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <Chip tone="danger" dot>
            open
          </Chip>
          <Chip tone="success" dot>
            resolved
          </Chip>
          <Chip tone="accent" dot>
            active
          </Chip>
        </div>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 07 — Callouts
// ---------------------------------------------------------------------------

function CalloutsBento() {
  return (
    <div className="grid grid-cols-12 gap-3">
      <Tile className="col-span-12 md:col-span-4">
        <PanelLabel>Status chip</PanelLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <OutOfCreditsBadge />
        </div>
      </Tile>
      <Tile className="col-span-12 md:col-span-8">
        <PanelLabel>Banner</PanelLabel>
        <OutOfCreditsBanner />
      </Tile>
    </div>
  );
}
