import { type ReactNode, useState } from "react";
import { Btn, Chip, ThemeToggle, Wordmark } from "./ui.tsx";

type ConceptId = "command" | "rail" | "stack" | "deck" | "briefing";

const CONCEPTS: Array<{
  id: ConceptId;
  number: string;
  name: string;
  thesis: string;
}> = [
  {
    id: "command",
    number: "01",
    name: "Command center",
    thesis: "A dense, always-on health grid",
  },
  {
    id: "rail",
    number: "02",
    name: "Dashboard rail",
    thesis: "Pinned dashboards become home navigation",
  },
  {
    id: "stack",
    number: "03",
    name: "Signal stack",
    thesis: "One calm, scrollable operational story",
  },
  {
    id: "deck",
    number: "04",
    name: "Pulse deck",
    thesis: "Swipeable dashboards for fast scanning",
  },
  {
    id: "briefing",
    number: "05",
    name: "Daily briefing",
    thesis: "Narrative status first, charts second",
  },
];

export function HomeDashboardMockups() {
  const [active, setActive] = useState<ConceptId>("command");
  const concept = CONCEPTS.find((item) => item.id === active) ?? CONCEPTS[0]!;

  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Wordmark size="sm" />
            <span className="hidden h-4 w-px bg-border sm:block" />
            <span className="hidden text-[12px] text-muted sm:inline">Home dashboard studio</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="/design" className="text-[12px] text-muted hover:text-fg">
              Design system
            </a>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-5 pb-20 pt-10 sm:px-8 sm:pt-14">
        <div className="max-w-3xl">
          <div className="mb-3 text-[12px] font-medium text-accent">
            Five directions · one decision
          </div>
          <h1 className="text-[36px] font-semibold leading-[1.08] tracking-[-0.035em] sm:text-[48px]">
            What should home feel like?
          </h1>
          <p className="mt-4 max-w-2xl text-[14px] leading-6 text-muted">
            Each concept puts saved dashboards and their widgets on the overview, but changes the
            hierarchy, density, and way you move through them.
          </p>
        </div>

        <nav
          aria-label="Dashboard home concepts"
          className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-5"
        >
          {CONCEPTS.map((item) => {
            const selected = item.id === active;
            return (
              <button
                key={item.id}
                type="button"
                data-dashboard-concept={item.id}
                aria-pressed={selected}
                onClick={() => setActive(item.id)}
                className={`min-h-28 bg-surface p-4 text-left transition-colors hover:bg-surface-2 ${
                  selected ? "bg-surface-3" : ""
                }`}
              >
                <span
                  className={`text-[11px] tabular-nums ${selected ? "text-accent" : "text-subtle"}`}
                >
                  {item.number}
                </span>
                <span className="mt-3 block text-[13px] font-medium text-fg">{item.name}</span>
                <span className="mt-1 block text-[11px] leading-4 text-muted">{item.thesis}</span>
              </button>
            );
          })}
        </nav>

        <section className="mt-8">
          <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <div className="text-[11px] tabular-nums text-accent">Concept {concept.number}</div>
              <h2 className="mt-1 text-[22px] font-semibold tracking-tight">{concept.name}</h2>
              <p className="mt-1 text-[12px] text-muted">{concept.thesis}</p>
            </div>
            <div className="text-[11px] text-subtle">Interactive mockup · sample data</div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl shadow-black/20">
            <ConceptFrame>{renderConcept(active)}</ConceptFrame>
          </div>
        </section>
      </main>
    </div>
  );
}

function ConceptFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[760px] bg-bg">
      <div className="flex h-12 items-center justify-between border-b border-border bg-surface px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-success" />
          <span className="text-[11px] text-muted">Acme / Production</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <span className="hidden sm:inline">Last 3 hours</span>
          <span className="rounded-md border border-border bg-surface-2 px-2 py-1">Now</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function renderConcept(id: ConceptId) {
  switch (id) {
    case "rail":
      return <DashboardRail />;
    case "stack":
      return <SignalStack />;
    case "deck":
      return <PulseDeck />;
    case "briefing":
      return <DailyBriefing />;
    default:
      return <CommandCenter />;
  }
}

function CommandCenter() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <MockPageTitle
        eyebrow="Overview"
        title="System command center"
        copy="Every pinned widget, composed into a single live health surface."
        action="Customize home"
      />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Request volume" value="84.2k" delta="+12.8%" tone="accent" />
        <Metric label="Error rate" value="0.72%" delta="−0.14%" tone="success" />
        <Metric label="P95 latency" value="242 ms" delta="+31 ms" tone="warning" />
        <Metric label="Open incidents" value="2" delta="1 critical" tone="danger" />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-12">
        <Widget title="Traffic and errors" meta="API health · Last 3h" className="lg:col-span-8">
          <AreaChart />
        </Widget>
        <Widget title="Service health" meta="12 services" className="lg:col-span-4">
          <ServiceHealth />
        </Widget>
        <Widget title="Latency by service" meta="P95 duration" className="lg:col-span-5">
          <LatencyBars />
        </Widget>
        <Widget title="Recent incidents" meta="2 need attention" className="lg:col-span-7">
          <IncidentList />
        </Widget>
      </div>
    </div>
  );
}

function DashboardRail() {
  const dashboards = [
    ["Production API", "8 widgets"],
    ["Checkout", "6 widgets"],
    ["Infrastructure", "11 widgets"],
    ["Release health", "4 widgets"],
  ];
  return (
    <div className="grid min-h-[712px] md:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="border-b border-border bg-surface/60 p-4 md:border-b-0 md:border-r md:p-5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-subtle">Pinned dashboards</span>
          <button className="text-[16px] text-muted" type="button" aria-label="Add dashboard">
            +
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-1 md:grid-cols-1">
          {dashboards.map(([name, count], index) => (
            <button
              type="button"
              key={name}
              className={`rounded-lg p-3 text-left ${
                index === 0 ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2"
              }`}
            >
              <span className="block text-[12px] font-medium">{name}</span>
              <span className="mt-1 block text-[10px] text-subtle">{count}</span>
            </button>
          ))}
        </div>
        <div className="mt-6 hidden border-t border-border pt-5 md:block">
          <span className="text-[10px] text-subtle">
            Home can remember the last dashboard you viewed.
          </span>
        </div>
      </aside>
      <div className="p-4 sm:p-6 lg:p-8">
        <MockPageTitle
          eyebrow="Dashboard"
          title="Production API"
          copy="A saved dashboard is the home page. Switch context without leaving overview."
          action="Edit layout"
        />
        <div className="mt-6 grid gap-3 lg:grid-cols-3">
          <Widget title="Request rate" meta="1.4k / min" className="lg:col-span-2">
            <AreaChart compact />
          </Widget>
          <Widget title="Availability" meta="30 day target">
            <Gauge />
          </Widget>
          <Widget title="Slowest endpoints" meta="P95 latency" className="lg:col-span-3">
            <EndpointTable />
          </Widget>
        </div>
      </div>
    </div>
  );
}

function SignalStack() {
  return (
    <div className="mx-auto max-w-[940px] px-4 py-8 sm:px-8 sm:py-12">
      <MockPageTitle
        eyebrow="Good morning, Ash"
        title="Production is stable"
        copy="A vertical story that reveals detail as you scroll, optimized for a calm daily check-in."
        action="Arrange stack"
      />
      <div className="mt-8 space-y-4">
        <section className="rounded-2xl border border-success/30 bg-success/5 p-5 sm:p-7">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-medium text-success">
                <span className="h-2 w-2 rounded-full bg-success" /> All systems operational
              </div>
              <div className="mt-3 text-[30px] font-semibold tracking-tight">99.98%</div>
              <div className="mt-1 text-[11px] text-muted">Availability over the last 24 hours</div>
            </div>
            <div className="flex gap-6">
              <StackStat label="Requests" value="1.2m" />
              <StackStat label="Errors" value="8.4k" />
              <StackStat label="Deploys" value="3" />
            </div>
          </div>
        </section>
        <section className="rounded-2xl border border-border bg-surface p-5 sm:p-7">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-[11px] text-subtle">Pinned from API health</div>
              <h3 className="mt-1 text-[16px] font-medium">
                Traffic settled after the morning peak
              </h3>
            </div>
            <span className="text-[11px] text-muted">Last 12h</span>
          </div>
          <div className="mt-6">
            <AreaChart />
          </div>
        </section>
        <section className="grid gap-4 sm:grid-cols-2">
          <Widget title="What changed" meta="Since yesterday">
            <DeployTimeline />
          </Widget>
          <Widget title="Worth watching" meta="2 signals">
            <WatchList />
          </Widget>
        </section>
      </div>
    </div>
  );
}

function PulseDeck() {
  return (
    <div className="overflow-hidden py-8 sm:py-10">
      <div className="px-5 sm:px-8">
        <MockPageTitle
          eyebrow="Home deck · 4 cards"
          title="Scan the pulse"
          copy="Each dashboard becomes a large card. Move horizontally; expand only when something looks wrong."
          action="Manage deck"
        />
      </div>
      <div className="mt-8 flex snap-x gap-4 overflow-x-auto px-5 pb-5 sm:px-8">
        <DeckCard
          title="API health"
          status="Healthy"
          tone="success"
          className="min-w-[82%] lg:min-w-[48%]"
        >
          <div className="mt-8 grid grid-cols-3 gap-4">
            <DeckMetric label="Throughput" value="1.4k/s" />
            <DeckMetric label="P95" value="242ms" />
            <DeckMetric label="Errors" value="0.72%" />
          </div>
          <div className="mt-7">
            <AreaChart compact />
          </div>
        </DeckCard>
        <DeckCard
          title="Checkout"
          status="Degraded"
          tone="warning"
          className="min-w-[82%] lg:min-w-[48%]"
        >
          <div className="mt-8 text-[46px] font-semibold tracking-[-0.05em]">97.8%</div>
          <div className="text-[11px] text-muted">Successful checkouts</div>
          <div className="mt-8">
            <LatencyBars />
          </div>
        </DeckCard>
        <DeckCard
          title="Infrastructure"
          status="Healthy"
          tone="success"
          className="min-w-[82%] lg:min-w-[48%]"
        >
          <div className="mt-7">
            <ServiceHealth />
          </div>
        </DeckCard>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <span className="h-1.5 w-6 rounded-full bg-fg" />
        <span className="h-1.5 w-1.5 rounded-full bg-surface-3" />
        <span className="h-1.5 w-1.5 rounded-full bg-surface-3" />
        <span className="h-1.5 w-1.5 rounded-full bg-surface-3" />
      </div>
    </div>
  );
}

function DailyBriefing() {
  return (
    <div className="grid min-h-[712px] lg:grid-cols-[minmax(320px,0.75fr)_minmax(0,1.45fr)]">
      <section className="border-b border-border bg-surface/55 p-6 sm:p-8 lg:border-b-0 lg:border-r lg:p-10">
        <div className="text-[11px] text-accent">Thursday, 16 July</div>
        <h2 className="mt-4 text-[34px] font-semibold leading-[1.08] tracking-[-0.035em]">
          Your systems had a quiet night.
        </h2>
        <p className="mt-5 text-[13px] leading-6 text-muted">
          Availability stayed above target. Checkout latency rose for 18 minutes after the 06:42
          deploy, then recovered without intervention.
        </p>
        <div className="mt-8 border-t border-border pt-6">
          <div className="text-[11px] font-medium text-subtle">Three things to know</div>
          <ol className="mt-4 space-y-5">
            <BriefingItem
              number="1"
              title="No overnight incidents"
              copy="The last SEV-2 closed 3 days ago."
            />
            <BriefingItem
              number="2"
              title="Latency briefly peaked"
              copy="Payments reached 612 ms at 06:47."
            />
            <BriefingItem
              number="3"
              title="Volume is trending up"
              copy="12.8% above the same period last week."
            />
          </ol>
        </div>
        <Btn variant="secondary" className="mt-8">
          Open full briefing
        </Btn>
      </section>
      <section className="p-5 sm:p-8 lg:p-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] text-subtle">Pinned evidence</div>
            <h3 className="mt-1 text-[16px] font-medium">What the summary is based on</h3>
          </div>
          <button type="button" className="text-[11px] text-muted hover:text-fg">
            Edit pins
          </button>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Metric label="Availability" value="99.98%" delta="Above SLO" tone="success" />
          <Metric label="Peak latency" value="612 ms" delta="Recovered" tone="warning" />
          <Widget title="Request volume" meta="vs. previous week" className="sm:col-span-2">
            <AreaChart compact />
          </Widget>
          <Widget title="Latest deploy" meta="api · 06:42" className="sm:col-span-2">
            <DeploySummary />
          </Widget>
        </div>
      </section>
    </div>
  );
}

function MockPageTitle({
  eyebrow,
  title,
  copy,
  action,
}: { eyebrow: string; title: string; copy: string; action: string }) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <div className="text-[11px] text-subtle">{eyebrow}</div>
        <h3 className="mt-1 text-[26px] font-semibold tracking-tight">{title}</h3>
        <p className="mt-2 max-w-2xl text-[12px] leading-5 text-muted">{copy}</p>
      </div>
      <Btn variant="secondary" size="sm">
        {action}
      </Btn>
    </div>
  );
}

function Widget({
  title,
  meta,
  children,
  className = "",
}: { title: string; meta: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-surface p-4 sm:p-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[12px] font-medium">{title}</h4>
        <span className="text-[10px] text-subtle">{meta}</span>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Metric({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: string;
  delta: string;
  tone: "accent" | "success" | "warning" | "danger";
}) {
  const tones = {
    accent: "text-accent",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  };
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-[10px] text-subtle">{label}</div>
      <div className="mt-2 text-[24px] font-semibold tracking-tight tabular-nums">{value}</div>
      <div className={`mt-1 text-[10px] ${tones[tone]}`}>{delta}</div>
    </div>
  );
}

function AreaChart({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      viewBox="0 0 640 180"
      className={`w-full ${compact ? "h-36" : "h-44"}`}
      preserveAspectRatio="none"
      aria-label="Traffic chart"
    >
      {[30, 75, 120, 165].map((y) => (
        <line key={y} x1="0" x2="640" y1={y} y2={y} className="stroke-border" />
      ))}
      <path
        d="M0 142 C42 132 64 105 102 115 S166 82 208 91 S270 54 312 68 S382 45 424 62 S492 36 536 49 S598 22 640 34 L640 180 L0 180 Z"
        className="fill-accent/10"
      />
      <path
        d="M0 142 C42 132 64 105 102 115 S166 82 208 91 S270 54 312 68 S382 45 424 62 S492 36 536 49 S598 22 640 34"
        fill="none"
        className="stroke-accent"
        strokeWidth="2"
      />
      <path
        d="M0 158 C70 155 110 148 166 152 S238 133 290 146 S370 128 422 139 S500 119 550 132 S602 111 640 121"
        fill="none"
        className="stroke-danger"
        strokeWidth="1.5"
        strokeDasharray="4 5"
      />
    </svg>
  );
}

function ServiceHealth() {
  const rows = [
    ["api", "99.99%", "success"],
    ["checkout", "99.82%", "warning"],
    ["worker", "99.97%", "success"],
    ["postgres", "100%", "success"],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([name, value, tone]) => (
        <div
          key={name}
          className="flex items-center justify-between rounded-lg px-2 py-2.5 hover:bg-surface-2"
        >
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${tone === "warning" ? "bg-warning" : "bg-success"}`}
            />
            <span className="text-[11px]">{name}</span>
          </div>
          <span className="text-[10px] tabular-nums text-muted">{value}</span>
        </div>
      ))}
    </div>
  );
}

function LatencyBars() {
  const rows = [
    ["checkout", "78%", "612 ms"],
    ["api", "52%", "242 ms"],
    ["worker", "34%", "184 ms"],
    ["auth", "21%", "91 ms"],
  ];
  return (
    <div className="space-y-3">
      {rows.map(([name, width, value]) => (
        <div key={name}>
          <div className="mb-1.5 flex justify-between text-[10px]">
            <span className="text-muted">{name}</span>
            <span className="tabular-nums text-fg">{value}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function IncidentList() {
  return (
    <div className="divide-y divide-border">
      <IncidentRow
        severity="SEV-2"
        title="Checkout latency above SLO"
        service="checkout"
        time="18m"
      />
      <IncidentRow
        severity="SEV-3"
        title="Queue depth growing in us-west"
        service="worker"
        time="42m"
      />
      <IncidentRow severity="Resolved" title="Elevated API error rate" service="api" time="2h" />
    </div>
  );
}

function IncidentRow({
  severity,
  title,
  service,
  time,
}: { severity: string; title: string; service: string; time: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-3 first:pt-0 last:pb-0">
      <Chip
        tone={severity === "SEV-2" ? "danger" : severity === "Resolved" ? "success" : "warning"}
      >
        {severity}
      </Chip>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-fg">{title}</div>
        <div className="mt-0.5 text-[10px] text-subtle">{service}</div>
      </div>
      <span className="text-[10px] text-subtle">{time}</span>
    </div>
  );
}

function Gauge() {
  return (
    <div className="flex h-36 flex-col items-center justify-center">
      <div className="relative flex h-24 w-48 items-end justify-center overflow-hidden">
        <div className="absolute inset-0 rounded-t-full border-[18px] border-surface-3 border-b-0" />
        <div className="absolute inset-0 rotate-[42deg] rounded-t-full border-[18px] border-success border-b-0 [clip-path:inset(0_50%_0_0)]" />
        <div className="pb-1 text-[28px] font-semibold tabular-nums">99.98%</div>
      </div>
      <div className="text-[10px] text-success">Above 99.9% target</div>
    </div>
  );
}

function EndpointTable() {
  const rows: Array<[string, string, string]> = [
    ["POST /v1/checkout", "612 ms", "+18%"],
    ["GET /v1/orders/:id", "348 ms", "+4%"],
    ["POST /v1/auth/session", "291 ms", "−2%"],
  ];
  return (
    <div className="divide-y divide-border">
      {rows.map(([path, latency, delta]) => (
        <div key={path} className="grid grid-cols-[1fr_auto_auto] gap-6 py-3 text-[11px]">
          <span className="superlog-code truncate text-muted">{path}</span>
          <span className="tabular-nums">{latency}</span>
          <span className={delta.startsWith("+") ? "text-warning" : "text-success"}>{delta}</span>
        </div>
      ))}
    </div>
  );
}

function StackStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[18px] font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-[10px] text-muted">{label}</div>
    </div>
  );
}
function DeployTimeline() {
  return (
    <div className="space-y-4">
      <TimelineRow time="06:42" title="api v2.84.1 deployed" tone="success" />
      <TimelineRow time="02:18" title="worker config updated" tone="accent" />
      <TimelineRow time="Yesterday" title="checkout v4.12.0" tone="success" />
    </div>
  );
}
function TimelineRow({
  time,
  title,
  tone,
}: { time: string; title: string; tone: "success" | "accent" }) {
  return (
    <div className="grid grid-cols-[52px_auto_1fr] items-center gap-2 text-[10px]">
      <span className="text-subtle">{time}</span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${tone === "success" ? "bg-success" : "bg-accent"}`}
      />
      <span className="text-muted">{title}</span>
    </div>
  );
}
function WatchList() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-warning/10 p-3">
        <div className="text-[11px] text-warning">Checkout P95</div>
        <div className="mt-1 text-[10px] leading-4 text-muted">18% above its 7-day baseline</div>
      </div>
      <div className="rounded-lg bg-accent-soft p-3">
        <div className="text-[11px] text-accent">Worker queue</div>
        <div className="mt-1 text-[10px] leading-4 text-muted">
          Backlog is rising but within target
        </div>
      </div>
    </div>
  );
}

function DeckCard({
  title,
  status,
  tone,
  children,
  className,
}: {
  title: string;
  status: string;
  tone: "success" | "warning";
  children: ReactNode;
  className: string;
}) {
  return (
    <section
      className={`snap-center rounded-2xl border border-border bg-surface p-6 sm:p-8 ${className}`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[18px] font-medium">{title}</h3>
        <Chip tone={tone} dot>
          {status}
        </Chip>
      </div>
      {children}
      <div className="mt-8 flex items-center justify-between border-t border-border pt-4 text-[10px] text-subtle">
        <span>Saved dashboard</span>
        <span>Open dashboard →</span>
      </div>
    </section>
  );
}
function DeckMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[20px] font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-[10px] text-muted">{label}</div>
    </div>
  );
}

function BriefingItem({ number, title, copy }: { number: string; title: string; copy: string }) {
  return (
    <li className="grid grid-cols-[20px_1fr] gap-3">
      <span className="text-[11px] tabular-nums text-accent">{number}</span>
      <div>
        <div className="text-[12px] font-medium">{title}</div>
        <p className="mt-1 text-[11px] leading-4 text-muted">{copy}</p>
      </div>
    </li>
  );
}
function DeploySummary() {
  return (
    <div className="flex flex-col justify-between gap-4 rounded-lg bg-surface-2 p-4 sm:flex-row sm:items-center">
      <div>
        <div className="text-[11px] font-medium">Improve checkout retry behavior</div>
        <div className="mt-1 text-[10px] text-muted">7 files changed · 18 minutes ago</div>
      </div>
      <Chip tone="success" dot>
        Healthy
      </Chip>
    </div>
  );
}
