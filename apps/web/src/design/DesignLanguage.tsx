import { type ReactNode, useState } from "react";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import {
  Btn,
  Chip,
  DataList,
  DataListCell,
  DataListHeader,
  DataListHeaderCell,
  DataListRow,
  Input,
  OutOfCreditsBadge,
  OutOfCreditsBanner,
  PageHeader,
  SearchInput,
  Tabs,
  ThemeToggle,
  Tile,
  Wordmark,
} from "./ui.tsx";

// The living system sheet for the real primitives shipped by the product.
// It intentionally reads like an operational workspace: quiet chrome, dense
// data, hairline structure, and color reserved for state and selection.

const NAV_GROUPS = [
  {
    label: "Foundation",
    items: [
      { id: "overview", label: "Overview" },
      { id: "tokens", label: "Tokens" },
      { id: "typography", label: "Typography" },
    ],
  },
  {
    label: "Patterns",
    items: [
      { id: "actions", label: "Actions & fields" },
      { id: "selection", label: "Selection" },
      { id: "data", label: "Data display" },
      { id: "feedback", label: "Feedback" },
    ],
  },
];

export function DesignLanguage() {
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <Sidebar />
      <div className="md:pl-56">
        <TopBar />
        <main className="mx-auto max-w-[1180px] px-5 pb-28 sm:px-8 lg:px-12">
          <Hero />
          <Overview />
          <Tokens />
          <Typography />
          <Actions />
          <Selection />
          <DataDisplay />
          <Feedback />
          <Footer />
        </main>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-border bg-surface/55 px-4 py-5 backdrop-blur md:flex">
      <div className="px-2">
        <Wordmark size="sm" />
        <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          Interface system
        </div>
      </div>

      <nav aria-label="Design language sections" className="mt-10 space-y-7">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2 text-[11px] font-medium text-subtle">{group.label}</div>
            <div className="mt-2 space-y-0.5">
              {group.items.map((item, index) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-surface-2 hover:text-fg ${
                    group.label === "Foundation" && index === 0
                      ? "bg-surface-3 text-fg"
                      : "text-muted"
                  }`}
                >
                  {item.label}
                </a>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto border-t border-border px-2 pt-4">
        <div className="flex items-center justify-between text-[11px] text-subtle">
          <span>Superlog UI</span>
          <span className="font-sans">v2.0</span>
        </div>
      </div>
    </aside>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur-md">
      <div className="flex h-14 items-center justify-between px-5 sm:px-8 lg:px-12">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span className="md:hidden">
            <Wordmark size="sm" />
          </span>
          <span className="hidden md:inline">Library</span>
          <span className="hidden text-subtle md:inline">/</span>
          <span className="hidden text-fg md:inline">Design language</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden h-7 w-44 items-center justify-between rounded-md border border-border bg-surface px-2.5 text-[11px] text-subtle sm:flex">
            <span>Search components…</span>
            <span className="font-sans">⌘K</span>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="pb-14 pt-16 sm:pb-16 sm:pt-24">
      <div className="max-w-3xl">
        <div className="mb-5 flex items-center gap-2 text-[12px] font-medium text-accent">
          <span className="h-px w-5 bg-accent" />
          Superlog interface system
        </div>
        <h1 className="text-balance text-[44px] font-semibold leading-[0.98] tracking-tightest text-fg sm:text-[64px] lg:text-[72px]">
          A quiet interface
          <br />
          for noisy systems.
        </h1>
        <p className="mt-6 max-w-xl text-[15px] leading-7 text-muted">
          Operational software should make dense information feel calm. Structure comes from spacing
          and hairlines; color appears only when it carries meaning.
        </p>
        <div className="mt-8 flex flex-wrap gap-2">
          <Btn size="lg">
            Browse components <span aria-hidden>→</span>
          </Btn>
          <Btn size="lg" variant="secondary">
            Read the principles
          </Btn>
        </div>
      </div>

      <div className="mt-16 grid border-y border-border sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["07", "core primitives"],
          ["08px", "spacing rhythm"],
          ["AA", "contrast target"],
          ["01", "action accent"],
        ].map(([value, label], index) => (
          <div
            key={label}
            className={`py-5 sm:px-5 ${index > 0 ? "sm:border-l sm:border-border" : ""}`}
          >
            <span className="font-sans text-[20px] font-semibold tabular-nums text-fg">
              {value}
            </span>
            <span className="ml-2 text-[12px] text-subtle">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionHeading({
  number,
  title,
  copy,
}: {
  number: string;
  title: string;
  copy: string;
}) {
  return (
    <header className="mb-6 grid gap-3 border-t border-border pt-5 sm:grid-cols-[1fr_1fr] sm:items-end">
      <div className="flex items-baseline gap-3">
        <span className="font-sans text-[11px] tabular-nums text-subtle">{number}</span>
        <h2 className="text-[25px] font-semibold tracking-tight text-fg">{title}</h2>
      </div>
      <p className="max-w-md text-[13px] leading-6 text-muted sm:justify-self-end">{copy}</p>
    </header>
  );
}

function Overview() {
  const principles = [
    {
      title: "Dense data, clear hierarchy",
      copy: "Keep telemetry close together, then separate meaning with type, alignment, and rhythm.",
      preview: <DensityPreview />,
    },
    {
      title: "Quiet by default",
      copy: "Surfaces differ by a few points. Hairlines do the work that shadows usually try to do.",
      preview: <SurfacePreview />,
    },
    {
      title: "Color carries state",
      copy: "Blue selects. Green confirms. Amber warns. Red interrupts. Everything else stays neutral.",
      preview: <StatePreview />,
    },
  ];

  return (
    <section id="overview" className="scroll-mt-20 pb-24">
      <SectionHeading
        number="01"
        title="Principles"
        copy="A system for observability work: information-rich, low-glare, and precise without feeling clinical."
      />
      <div className="grid gap-3 lg:grid-cols-3">
        {principles.map((principle) => (
          <Tile key={principle.title} className="overflow-hidden" padded={false}>
            <div className="h-36 border-b border-border bg-bg/35 p-5">{principle.preview}</div>
            <div className="p-5">
              <h3 className="text-[15px] font-medium text-fg">{principle.title}</h3>
              <p className="mt-2 text-[13px] leading-5 text-muted">{principle.copy}</p>
            </div>
          </Tile>
        ))}
      </div>
    </section>
  );
}

function DensityPreview() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      {["checkout-api", "billing-worker", "edge-proxy"].map((service, index) => (
        <div
          key={service}
          className="flex items-center border-b border-border px-3 py-2 last:border-0"
        >
          <span className="w-5 font-sans text-[10px] text-subtle">0{index + 1}</span>
          <span className="flex-1 text-[11px] text-muted">{service}</span>
          <span className="font-sans text-[10px] tabular-nums text-fg">
            {[128, 84, 211][index]}ms
          </span>
        </div>
      ))}
    </div>
  );
}

function SurfacePreview() {
  return (
    <div className="relative h-full">
      <div className="absolute inset-x-7 inset-y-2 rounded-lg border border-border bg-surface-3" />
      <div className="absolute inset-x-3 inset-y-5 rounded-lg border border-border bg-surface-2" />
      <div className="absolute inset-x-0 inset-y-8 flex items-center justify-center rounded-lg border border-border bg-surface text-[11px] text-muted">
        structure, not shadow
      </div>
    </div>
  );
}

function StatePreview() {
  return (
    <div className="grid h-full grid-cols-2 gap-2">
      {[
        ["Selected", "bg-accent", "text-accent"],
        ["Healthy", "bg-success", "text-success"],
        ["Degraded", "bg-warning", "text-warning"],
        ["Failed", "bg-danger", "text-danger"],
      ].map(([label, dot, text]) => (
        <div
          key={label}
          className="flex items-center rounded-md border border-border bg-surface px-3"
        >
          <span className={`mr-2 h-1.5 w-1.5 rounded-full ${dot}`} />
          <span className={`text-[11px] ${text}`}>{label}</span>
        </div>
      ))}
    </div>
  );
}

const SWATCHES = [
  { name: "Canvas", value: "#171717", className: "bg-bg" },
  { name: "Surface", value: "#1D1D1D", className: "bg-surface" },
  { name: "Raised", value: "#222222", className: "bg-surface-2" },
  { name: "Selected", value: "#2B2B2B", className: "bg-surface-3" },
  { name: "Primary ink", value: "#DCDCDC", className: "bg-fg" },
  { name: "Muted ink", value: "#8C8C8C", className: "bg-muted" },
];

function Tokens() {
  return (
    <section id="tokens" className="scroll-mt-20 pb-24">
      <SectionHeading
        number="02"
        title="Operational palette"
        copy="Near-black layers carry the interface. Muted, slightly desaturated signals stay legible without glowing."
      />
      <div className="grid gap-3 lg:grid-cols-[1.45fr_1fr]">
        <Tile>
          <PanelLabel>Neutral foundation</PanelLabel>
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3">
            {SWATCHES.map((swatch) => (
              <div key={swatch.name}>
                <div className={`h-16 rounded-md border border-border ${swatch.className}`} />
                <div className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-muted">{swatch.name}</span>
                  <span className="font-sans text-[10px] tabular-nums text-subtle">
                    {swatch.value}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Tile>
        <Tile>
          <PanelLabel>Semantic signals</PanelLabel>
          <div className="space-y-2">
            {[
              ["Selection", "#73B2DE", "bg-accent"],
              ["Healthy", "#7FC797", "bg-success"],
              ["Attention", "#C99D66", "bg-warning"],
              ["Critical", "#D97178", "bg-danger"],
            ].map(([name, value, fill]) => (
              <div
                key={name}
                className="flex items-center rounded-md border border-border bg-bg/30 p-2.5"
              >
                <span className={`mr-3 h-7 w-7 rounded ${fill}`} />
                <span className="flex-1 text-[12px] text-muted">{name}</span>
                <span className="font-sans text-[10px] text-subtle">{value}</span>
              </div>
            ))}
          </div>
        </Tile>
      </div>
    </section>
  );
}

function Typography() {
  return (
    <section id="typography" className="scroll-mt-20 pb-24">
      <SectionHeading
        number="03"
        title="Typography & rhythm"
        copy="One sans-serif family carries hierarchy, reading, identifiers, timing, and tabular values without changing visual voice."
      />
      <div className="grid gap-3 lg:grid-cols-[1.45fr_1fr]">
        <Tile>
          <PanelLabel>Display · Inter</PanelLabel>
          <div className="mt-10 text-[42px] font-semibold leading-[0.98] tracking-tightest text-fg sm:text-[58px]">
            Signals in,
            <br />
            clarity out.
          </div>
          <p className="mt-8 max-w-lg text-[14px] leading-6 text-muted">
            Calm typography gives operational data room to breathe without making the interface feel
            sparse.
          </p>
        </Tile>
        <Tile>
          <PanelLabel>Scale</PanelLabel>
          <div className="divide-y divide-border">
            {[
              ["Display", "64 / 64", "Semibold"],
              ["Title", "25 / 30", "Semibold"],
              ["Body", "14 / 24", "Regular"],
              ["Small", "12 / 18", "Regular"],
              ["Data", "11 / 16", "Medium"],
            ].map(([name, size, weight]) => (
              <div key={name} className="grid grid-cols-[1fr_auto_auto] gap-4 py-3 text-[11px]">
                <span className="text-muted">{name}</span>
                <span className="font-sans text-subtle">{size}</span>
                <span className="w-16 text-right text-subtle">{weight}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-border pt-5">
            <PanelLabel>8px rhythm</PanelLabel>
            <div className="flex items-end gap-2">
              {[4, 8, 12, 16, 24, 32, 48].map((space) => (
                <div key={space} className="flex flex-1 flex-col items-center gap-2">
                  <span
                    className="w-full rounded-sm bg-accent/55"
                    style={{ height: `${space}px` }}
                  />
                  <span className="font-sans text-[9px] text-subtle">{space}</span>
                </div>
              ))}
            </div>
          </div>
        </Tile>
      </div>
    </section>
  );
}

const ENV_OPTIONS: DropdownOption[] = [
  { value: "production", label: "production" },
  { value: "staging", label: "staging" },
  { value: "preview", label: "preview" },
];

function Actions() {
  const [environment, setEnvironment] = useState("production");
  return (
    <section id="actions" className="scroll-mt-20 pb-24">
      <SectionHeading
        number="04"
        title="Actions & fields"
        copy="Primary actions use neutral contrast. Blue remains available for selection and links instead of competing with every button."
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <Tile className="lg:col-span-2">
          <PanelLabel>Page heading</PanelLabel>
          <PageHeader
            title="Explore"
            description="Search and compare telemetry across the current project."
            actions={<Btn>Save view</Btn>}
          />
        </Tile>
        <Tile>
          <PanelLabel>Buttons</PanelLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Btn>Investigate</Btn>
            <Btn variant="secondary">Open trace</Btn>
            <Btn variant="ghost">Dismiss</Btn>
            <Btn variant="danger">Delete</Btn>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-5">
            <Btn size="sm">Small</Btn>
            <Btn>Medium</Btn>
            <Btn size="lg">Large</Btn>
            <Btn disabled>Disabled</Btn>
          </div>
        </Tile>
        <Tile>
          <PanelLabel>Fields</PanelLabel>
          <div className="space-y-4">
            <div>
              <FieldName>Search telemetry</FieldName>
              <SearchInput placeholder="service.name = checkout-api" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FieldName>Project name</FieldName>
                <Input defaultValue="Production" />
              </div>
              <div>
                <FieldName>Environment</FieldName>
                <Dropdown
                  value={environment}
                  onChange={setEnvironment}
                  options={ENV_OPTIONS}
                  searchable={false}
                />
              </div>
            </div>
          </div>
        </Tile>
      </div>
    </section>
  );
}

type View = "open" | "resolved" | "noise";

function Selection() {
  const [view, setView] = useState<View>("open");
  return (
    <section id="selection" className="scroll-mt-20 pb-24">
      <SectionHeading
        number="05"
        title="Selection & status"
        copy="Compact rectangular tags echo the data grid. Bare dots identify ongoing state without creating visual clutter."
      />
      <div className="grid gap-3 lg:grid-cols-[1.25fr_1fr]">
        <Tile>
          <PanelLabel>Tabs</PanelLabel>
          <Tabs
            value={view}
            onChange={setView}
            options={[
              { value: "open", label: "Open" },
              { value: "resolved", label: "Resolved" },
              { value: "noise", label: "Noise" },
            ]}
          />
          <div className="mt-5 rounded-lg border border-border bg-bg/35 p-4">
            <span className="text-[12px] font-medium text-fg capitalize">{view} incidents</span>
            <p className="mt-1 text-[12px] text-muted">
              The selected view changes; the surrounding frame stays quiet.
            </p>
          </div>
        </Tile>
        <Tile>
          <PanelLabel>Tags & live state</PanelLabel>
          <div className="flex flex-wrap gap-2">
            <Chip tone="neutral">neutral</Chip>
            <Chip tone="accent">selected</Chip>
            <Chip tone="success">healthy</Chip>
            <Chip tone="warning">degraded</Chip>
            <Chip tone="danger">critical</Chip>
          </div>
          <div className="mt-5 flex flex-wrap gap-4 border-t border-border pt-5">
            <Chip tone="success" dot>
              Live
            </Chip>
            <Chip tone="warning" dot>
              Delayed
            </Chip>
            <Chip tone="danger" dot>
              Failed
            </Chip>
          </div>
        </Tile>
      </div>
    </section>
  );
}

const SERVICES = [
  { service: "checkout-api", type: "trace", latency: "128ms", rate: "99.98%", tone: "success" },
  { service: "billing-worker", type: "log", latency: "842ms", rate: "98.41%", tone: "warning" },
  { service: "edge-proxy", type: "metric", latency: "74ms", rate: "99.99%", tone: "accent" },
  { service: "email-dispatch", type: "trace", latency: "1.24s", rate: "94.08%", tone: "danger" },
] as const;

function DataDisplay() {
  return (
    <section id="data" className="scroll-mt-20 pb-24">
      <SectionHeading
        number="06"
        title="Data display"
        copy="Rows align on a stable grid. Weight, alignment, and tabular numerals make dense values scan without changing typeface."
      />
      <div className="grid gap-3 lg:grid-cols-[1.6fr_0.7fr]">
        <DataList label="Service health">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-[12px] font-medium text-fg">Service health</span>
            <span className="font-sans text-[10px] text-subtle">live · 10s</span>
          </div>
          <DataListHeader className="grid grid-cols-[1.5fr_0.8fr_0.7fr_0.7fr]">
            <DataListHeaderCell>Service</DataListHeaderCell>
            <DataListHeaderCell>Signal</DataListHeaderCell>
            <DataListHeaderCell className="text-right">p95</DataListHeaderCell>
            <DataListHeaderCell className="text-right">Success</DataListHeaderCell>
          </DataListHeader>
          {SERVICES.map((row) => (
            <DataListRow
              key={row.service}
              className="grid grid-cols-[1.5fr_0.8fr_0.7fr_0.7fr] items-center"
            >
              <DataListCell className="truncate text-[12px] text-fg">{row.service}</DataListCell>
              <DataListCell>
                <Chip tone={row.tone}>{row.type}</Chip>
              </DataListCell>
              <DataListCell className="text-right font-sans text-[11px] tabular-nums text-muted">
                {row.latency}
              </DataListCell>
              <DataListCell className="text-right font-sans text-[11px] tabular-nums text-fg">
                {row.rate}
              </DataListCell>
            </DataListRow>
          ))}
        </DataList>
        <Tile>
          <PanelLabel>Current window</PanelLabel>
          <div className="font-sans text-[42px] font-semibold tracking-tight text-fg">12.8k</div>
          <div className="mt-1 text-[12px] text-muted">events / minute</div>
          <div className="mt-7 space-y-3 border-t border-border pt-5">
            {[
              ["Traces", "7.2k", "bg-accent", "56%"],
              ["Logs", "4.1k", "bg-success", "32%"],
              ["Metrics", "1.5k", "bg-warning", "12%"],
            ].map(([label, value, color, width]) => (
              <div key={label}>
                <div className="mb-1.5 flex justify-between text-[11px]">
                  <span className="text-muted">{label}</span>
                  <span className="font-sans text-subtle">{value}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-surface-3">
                  <div className={`h-full rounded-full ${color}`} style={{ width }} />
                </div>
              </div>
            ))}
          </div>
        </Tile>
      </div>
    </section>
  );
}

function Feedback() {
  return (
    <section id="feedback" className="scroll-mt-20 pb-10">
      <SectionHeading
        number="07"
        title="Feedback"
        copy="Use persistent feedback only when the system needs a decision. Keep labels brief and pair them with a clear next action."
      />
      <div className="grid gap-3 lg:grid-cols-[0.7fr_1.5fr]">
        <Tile>
          <PanelLabel>Inline status</PanelLabel>
          <OutOfCreditsBadge />
          <p className="mt-4 text-[12px] leading-5 text-muted">
            A compact tag for rows and summaries.
          </p>
        </Tile>
        <Tile>
          <PanelLabel>Decision banner</PanelLabel>
          <OutOfCreditsBanner />
        </Tile>
      </div>
    </section>
  );
}

function PanelLabel({ children }: { children: ReactNode }) {
  return <div className="mb-4 text-[11px] font-medium text-subtle">{children}</div>;
}

function FieldName({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[11px] font-medium text-muted">{children}</div>;
}

function Footer() {
  return (
    <footer className="mt-20 flex flex-col gap-2 border-t border-border pt-5 text-[11px] text-subtle sm:flex-row sm:items-center sm:justify-between">
      <span>Superlog · Interface system</span>
      <span>Shared tokens and production primitives</span>
    </footer>
  );
}
