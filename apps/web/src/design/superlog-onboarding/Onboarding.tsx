import { Fragment, useEffect, useState } from "react";
import { buildInstallPrompt, INSTALL_PROMPT } from "../../installPrompt.ts";
import { Button, Card, Checkbox, I, TextInput, Toggle, Wordmark } from "./atoms.tsx";
import type {
  AgentChoice,
  GithubData,
  OnboardingResult,
  ProgressStyle,
  SlackData,
  SlackPref,
} from "./types.ts";

const ONB_STEPS = [
  { id: "install", label: "Install", sub: "agent or wizard" },
  { id: "deploy", label: "Deploy", sub: "ship the code" },
] as const;

const MOCK_ORGS = [
  { id: "acme", name: "acme", avatar: "#485ae2", personal: false },
  { id: "ash-personal", name: "ash-personal", avatar: "#41d195", personal: true },
  { id: "open-orbit", name: "open-orbit", avatar: "#e7b15a", personal: false },
] as const;

const MOCK_REPOS = [
  { id: "acme/superlog-web", lastPush: "2h" },
  { id: "acme/api-gateway", lastPush: "4h" },
  { id: "acme/billing-service", lastPush: "1d" },
  { id: "acme/marketing-site", lastPush: "3d" },
  { id: "acme/infra", lastPush: "2d" },
  { id: "acme/playbooks", lastPush: "6d" },
  { id: "acme/cli", lastPush: "12h" },
  { id: "acme/notifier-worker", lastPush: "5h" },
  { id: "ash-personal/dotfiles", lastPush: "1mo" },
  { id: "ash-personal/scratchpad", lastPush: "9d" },
  { id: "open-orbit/satellite-bus", lastPush: "8h" },
  { id: "open-orbit/ground-station", lastPush: "1d" },
] as const;

const MOCK_CHANNELS = [
  { id: "eng-incidents", name: "eng-incidents" },
  { id: "eng", name: "eng" },
  { id: "eng-prs", name: "eng-prs" },
  { id: "platform", name: "platform" },
  { id: "frontend", name: "frontend" },
  { id: "releases", name: "releases" },
  { id: "general", name: "general" },
  { id: "random", name: "random" },
] as const;

// Write-only ingest key, baked into the install prompt + deploy snippets.
// Rotatable from settings, so leaking on screen during onboarding is acceptable.
const DEMO_API_KEY = "sk_live_8f4c7a09…b21c";

// ─── Atoms ──────────────────────────────────────────────────────────
function StepBadge({ state, n }: { state: "done" | "active" | "todo"; n: number }) {
  const bg =
    state === "done"
      ? "var(--sl-indigo)"
      : state === "active"
        ? "rgba(72,90,226,0.18)"
        : "rgba(255,255,255,0.04)";
  const color =
    state === "done" ? "#fff" : state === "active" ? "var(--sl-indigo-2)" : "var(--sl-fg-4)";
  const border =
    state === "done"
      ? "var(--sl-indigo)"
      : state === "active"
        ? "var(--sl-indigo-line)"
        : "var(--sl-line)";
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: bg,
        color,
        border: `1px solid ${border}`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        fontWeight: 500,
        flexShrink: 0,
        transition: "all 200ms ease",
      }}
    >
      {state === "done" ? I.check(11) : n}
    </span>
  );
}

function ProgressRail({ stepIdx, style = "rail" }: { stepIdx: number; style?: ProgressStyle }) {
  if (style === "dots") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {ONB_STEPS.map((s, i) => (
          <span
            key={s.id}
            style={{
              width: i === stepIdx ? 18 : 6,
              height: 6,
              borderRadius: 3,
              background:
                i < stepIdx
                  ? "var(--sl-indigo)"
                  : i === stepIdx
                    ? "var(--sl-indigo-2)"
                    : "rgba(255,255,255,0.12)",
              transition: "all 200ms ease",
            }}
          />
        ))}
      </div>
    );
  }
  if (style === "top") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "14px 24px",
          borderBottom: "1px solid var(--sl-line)",
        }}
      >
        {ONB_STEPS.map((s, i) => {
          const state: "done" | "active" | "todo" =
            i < stepIdx ? "done" : i === stepIdx ? "active" : "todo";
          return (
            <Fragment key={s.id}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <StepBadge state={state} n={i + 1} />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: state === "todo" ? "var(--sl-fg-4)" : "var(--sl-fg)",
                  }}
                >
                  {s.label}
                </span>
              </span>
              {i < ONB_STEPS.length - 1 && (
                <span
                  style={{
                    flex: 1,
                    height: 1,
                    background: i < stepIdx ? "var(--sl-indigo-line)" : "var(--sl-line)",
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    );
  }
  // rail
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "32px 28px",
        minWidth: 220,
      }}
    >
      <div style={{ marginBottom: 28 }}>
        <Wordmark />
      </div>
      {ONB_STEPS.map((s, i) => {
        const state: "done" | "active" | "todo" =
          i < stepIdx ? "done" : i === stepIdx ? "active" : "todo";
        return (
          <div
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 0",
              borderTop: i === 0 ? "1px solid var(--sl-line)" : "none",
              borderBottom: "1px solid var(--sl-line)",
            }}
          >
            <StepBadge state={state} n={i + 1} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: state === "todo" ? "var(--sl-fg-4)" : "var(--sl-fg)",
                }}
              >
                {s.label}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--sl-fg-4)", letterSpacing: 0 }}>
                {s.sub}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepHeader({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h1
        style={{
          margin: 0,
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: "-0.025em",
          lineHeight: 1.1,
        }}
      >
        {title}
      </h1>
      {sub &&
        (typeof sub === "string" ? (
          <p style={{ margin: "10px 0 0", color: "var(--sl-fg-3)", fontSize: 14, maxWidth: 540 }}>
            {sub}
          </p>
        ) : (
          <div style={{ marginTop: 10, color: "var(--sl-fg-3)", fontSize: 14, maxWidth: 540 }}>
            {sub}
          </div>
        ))}
    </div>
  );
}

type StepFooterProps = {
  onBack?: () => void;
  onSkip?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  skippable?: boolean;
};

function StepFooter({
  onBack,
  onSkip,
  onNext,
  nextLabel = "Continue",
  nextDisabled,
  skippable,
}: StepFooterProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 36,
        paddingTop: 20,
        borderTop: "1px solid var(--sl-line)",
      }}
    >
      <div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} leftIcon={I.arrowL(13)}>
            Back
          </Button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {skippable && (
          <Button variant="ghost" size="md" onClick={onSkip}>
            Skip for now
          </Button>
        )}
        {onNext && (
          <Button
            variant="primary"
            size="md"
            onClick={onNext}
            disabled={nextDisabled}
            rightIcon={I.arrow(13)}
          >
            {nextLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── GitHub sub-flow ────────────────────────────────────────────────
type StepProps<T> = {
  data: T;
  onChange: (next: T) => void;
  onNext: () => void;
  onSkip: () => void;
};

export function GitHubStep({ data, onChange, onNext, onSkip }: StepProps<GithubData>) {
  const sub = data.sub || "connect";
  const setSub = (v: GithubData["sub"]) => onChange({ ...data, sub: v });

  if (sub === "connect") {
    return (
      <>
        <StepHeader
          title="Connect GitHub"
          sub={
            <>
              <p style={{ margin: 0 }}>Superlog uses GitHub for two things:</p>
              <ul
                style={{
                  margin: "8px 0 0",
                  paddingLeft: 22,
                  listStyle: "disc",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <li style={{ display: "list-item" }}>Opening PRs that fix the issues we find.</li>
                <li style={{ display: "list-item" }}>
                  Scanning your codebase to add more observability where it's missing.
                </li>
              </ul>
            </>
          }
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          <Button variant="primary" leftIcon={I.github(14)} onClick={() => setSub("repos")}>
            Authorize
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </>
    );
  }

  // repos — combined with org via section grouping
  return (
    <>
      <StepHeader
        title="Install Superlog on which repos?"
        sub="Here are all the repos you have access to, grouped by org. Pick whichever you'd like Superlog to watch — you can add more later from settings."
      />
      <ReposPicker selected={data.repos || []} onChange={(repos) => onChange({ ...data, repos })} />
      <StepFooter
        onBack={() => setSub("connect")}
        onNext={onNext}
        nextDisabled={!data.repos || data.repos.length === 0}
        nextLabel={`Continue · ${data.repos?.length || 0} selected`}
      />
    </>
  );
}

type RepoRow = (typeof MOCK_REPOS)[number];

function ReposPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matches = (r: RepoRow) => !needle || r.id.toLowerCase().includes(needle);

  const groups = MOCK_ORGS.map((org) => ({
    org,
    repos: MOCK_REPOS.filter((r) => r.id.startsWith(`${org.id}/`) && matches(r)),
  })).filter((g) => g.repos.length > 0);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: 12, borderBottom: "1px solid var(--sl-line)" }}>
        <TextInput
          value={q}
          onChange={setQ}
          placeholder="Filter by repo name"
          leftIcon={I.search()}
        />
      </div>
      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        {groups.length === 0 && (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "var(--sl-fg-3)",
              fontSize: 13,
            }}
          >
            No repos match <span>"{q}"</span>.
          </div>
        )}
        {groups.map(({ org, repos }) => {
          const allSelectedInOrg = repos.every((r) => selected.includes(r.id));
          const onToggleAll = () => {
            const ids: string[] = repos.map((r) => r.id);
            if (allSelectedInOrg) onChange(selected.filter((x) => !ids.includes(x)));
            else onChange([...new Set([...selected, ...ids])]);
          };
          return (
            <div key={org.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 16px",
                  background: "var(--sl-bg-elev)",
                  borderBottom: "1px solid var(--sl-line)",
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    background: org.avatar,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#fff",
                    textTransform: "uppercase",
                  }}
                >
                  {org.name[0]}
                </span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{org.name}</span>
                {org.personal && (
                  <span style={{ fontSize: 10, color: "var(--sl-fg-4)" }}>personal</span>
                )}
                <span style={{ fontSize: 11, color: "var(--sl-fg-4)" }}>{repos.length}</span>
                <span style={{ flex: 1 }} />
                <Button variant="ghost" size="sm" onClick={onToggleAll}>
                  {allSelectedInOrg ? "Clear" : "Select all"}
                </Button>
              </div>
              {repos.map((r) => {
                const checked = selected.includes(r.id);
                const repoName = r.id.slice(org.id.length + 1);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggle(r.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "11px 16px 11px 28px",
                      borderBottom: "1px solid var(--sl-line)",
                      cursor: "pointer",
                      background: checked ? "rgba(72,90,226,0.04)" : "transparent",
                      width: "100%",
                      border: 0,
                      borderRadius: 0,
                      font: "inherit",
                      color: "inherit",
                      textAlign: "left",
                    }}
                  >
                    <Checkbox checked={checked} onChange={() => toggle(r.id)} />
                    <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{repoName}</span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--sl-fg-4)",
                        width: 40,
                        textAlign: "right",
                      }}
                    >
                      {r.lastPush}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Slack sub-flow ─────────────────────────────────────────────────
export function SlackStep({ data, onChange, onNext, onSkip }: StepProps<SlackData>) {
  const sub = data.sub || "connect";
  const setSub = (v: SlackData["sub"]) => onChange({ ...data, sub: v });

  if (sub === "connect") {
    return (
      <>
        <StepHeader
          title="Connect Slack"
          sub={
            <>
              <p style={{ margin: 0 }}>Superlog uses Slack for two things:</p>
              <ul
                style={{
                  margin: "8px 0 0",
                  paddingLeft: 22,
                  listStyle: "disc",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <li style={{ display: "list-item" }}>
                  Pinging you when something breaks, in the channel of your choice.
                </li>
                <li style={{ display: "list-item" }}>
                  Posting a weekly recap of what we shipped, fixed, and noticed.
                </li>
              </ul>
            </>
          }
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          <Button variant="primary" leftIcon={I.slack(14)} onClick={() => setSub("prefs")}>
            Add to Slack
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </>
    );
  }

  // prefs
  const incidents: SlackPref = data.incidents ?? { enabled: true, channel: "eng-incidents" };
  const recap: SlackPref = data.recap ?? { enabled: true, channel: "eng" };
  const setIncidents = (next: SlackPref) => onChange({ ...data, incidents: next });
  const setRecap = (next: SlackPref) => onChange({ ...data, recap: next });

  return (
    <>
      <StepHeader
        title="What should we send to Slack?"
        sub="Pick what you want, and where it should go. You can change either later."
      />
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <PrefRow
          title="Incident notifications"
          desc="When something breaks, we'll ping you in real time."
          pref={incidents}
          onChange={setIncidents}
        />
        <PrefRow
          title="Weekly recap"
          desc="What shipped, what broke, what we noticed — Mondays at 09:00 your time."
          pref={recap}
          onChange={setRecap}
          last
        />
      </Card>
      <StepFooter onBack={() => setSub("connect")} onNext={onNext} nextLabel="Continue" />
    </>
  );
}

function PrefRow({
  title,
  desc,
  pref,
  onChange,
  last,
}: {
  title: string;
  desc: string;
  pref: SlackPref;
  onChange: (next: SlackPref) => void;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "16px 18px",
        borderBottom: last ? "none" : "1px solid var(--sl-line)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: 12, color: "var(--sl-fg-3)", marginTop: 2 }}>{desc}</div>
        </div>
        <Toggle checked={pref.enabled} onChange={(v) => onChange({ ...pref, enabled: v })} />
      </div>
      {pref.enabled && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 0 }}>
          <span style={{ fontSize: 12, color: "var(--sl-fg-3)" }}>Send to</span>
          <ChannelSelect
            value={pref.channel}
            onChange={(channel) => onChange({ ...pref, channel })}
          />
        </div>
      )}
    </div>
  );
}

function ChannelSelect({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = MOCK_CHANNELS.find((c) => c.id === value) ?? MOCK_CHANNELS[0];
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 30,
          padding: "0 12px",
          background: "var(--sl-bg-elev)",
          border: "1px solid var(--sl-line-2)",
          borderRadius: 6,
          color: "var(--sl-fg)",
          fontSize: 12.5,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span style={{ color: "var(--sl-fg-3)", display: "inline-flex" }}>{I.hash(12)}</span>
        <span>{current.name}</span>
        <span style={{ color: "var(--sl-fg-4)", marginLeft: 4 }}>▾</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close channel picker"
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "transparent",
              border: 0,
              cursor: "default",
              zIndex: 5,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              minWidth: 200,
              maxHeight: 240,
              overflowY: "auto",
              background: "var(--sl-surface)",
              border: "1px solid var(--sl-line-2)",
              borderRadius: 8,
              boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
              padding: 4,
              zIndex: 6,
            }}
          >
            {MOCK_CHANNELS.map((c) => {
              const selected = c.id === current.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "8px 10px",
                    background: selected ? "rgba(72,90,226,0.1)" : "transparent",
                    border: 0,
                    borderRadius: 6,
                    color: "var(--sl-fg)",
                    fontSize: 12.5,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  <span style={{ color: "var(--sl-fg-3)", display: "inline-flex" }}>
                    {I.hash(12)}
                  </span>
                  <span style={{ flex: 1 }}>{c.name}</span>
                  {selected && (
                    <span style={{ color: "var(--sl-indigo-2)", display: "inline-flex" }}>
                      {I.check(12)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Agent step ─────────────────────────────────────────────────────
function AgentStep({
  onNext,
  onWizard,
  onSkip,
}: {
  onNext: () => void;
  onWizard: () => void;
  onSkip: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const prompt = buildInstallPrompt(DEMO_API_KEY);
  const copy = () => {
    try {
      navigator.clipboard?.writeText(prompt);
    } catch {
      // ignore — clipboard unavailable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <>
      <StepHeader
        title="Install Superlog"
        sub="Paste this prompt in Cursor, Claude Code, Codex, or any agent. It runs the install skill end-to-end — adds the SDK, instruments your code, opens a PR."
      />

      <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16, background: "#0a0a0c" }}>
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--sl-line)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ display: "inline-flex", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#3b3b3e" }} />
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#3b3b3e" }} />
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#3b3b3e" }} />
          </span>
          <span className="sl-onb-tiny" style={{ marginLeft: 8 }}>
            coding agent
          </span>
        </div>
        <div style={{ padding: "18px 22px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1, fontSize: 13.5, color: "var(--sl-fg)", lineHeight: 1.5 }}>
              {INSTALL_PROMPT}
              <br />
              Use API key <span style={{ color: "var(--sl-indigo-2)" }}>{DEMO_API_KEY}</span>.
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 14,
                  background: "var(--sl-indigo)",
                  verticalAlign: "-2px",
                  marginLeft: 2,
                  animation: "sl-onb-cursor 1s steps(1) infinite",
                }}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              leftIcon={copied ? I.check(13) : I.copy(13)}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--sl-fg-4)" }}>
            The key is write-only — it can only ingest events, not read them — and you can rotate it
            any time from settings. Safe to drop straight into your agent.
          </div>
        </div>
      </Card>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 18px",
          border: "1px dashed var(--sl-line-2)",
          borderRadius: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--sl-indigo-2)" }}>{I.bolt(14)}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>No agent? Use our managed wizard.</div>
            <div style={{ fontSize: 11.5, color: "var(--sl-fg-3)", marginTop: 2 }}>
              Hands-off · runs in Superlog cloud · opens a PR for review
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onWizard} rightIcon={I.arrow(13)}>
          Run wizard
        </Button>
      </div>

      <StepFooter onSkip={onSkip} skippable onNext={onNext} nextLabel="The agent is done" />
    </>
  );
}

// ─── Wizard running ─────────────────────────────────────────────────
const WIZARD_STEPS = [
  { k: "clone", t: "Cloning repository", d: "acme/superlog-web @ main" },
  { k: "analyze", t: "Analyzing codebase", d: "14 services · 412 files · TypeScript, Go" },
  { k: "plan", t: "Planning instrumentation", d: "OpenTelemetry, structured logs, traces" },
  { k: "patch", t: "Generating patches", d: "8 files · +229 −59" },
  { k: "verify", t: "Running checks", d: "type-check · tests · lints" },
  { k: "pr", t: "Opening pull request", d: "PR #113211 → main" },
] as const;

function WizardRunning({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (active >= WIZARD_STEPS.length) return;
    const t = setTimeout(() => setActive((a) => a + 1), 1200 + Math.random() * 600);
    return () => clearTimeout(t);
  }, [active]);
  const allDone = active >= WIZARD_STEPS.length;

  return (
    <>
      <StepHeader
        title="Running install"
        sub="Superlog's managed agent is doing the install on its own. You can keep this tab open or come back later — we'll ping you in Slack."
      />
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {WIZARD_STEPS.map((s, i) => {
          const state: "done" | "running" | "todo" =
            i < active ? "done" : i === active ? "running" : "todo";
          return (
            <div
              key={s.k}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "16px 20px",
                borderBottom: i === WIZARD_STEPS.length - 1 ? "none" : "1px solid var(--sl-line)",
                opacity: state === "todo" ? 0.45 : 1,
                transition: "opacity 200ms ease",
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color:
                    state === "done"
                      ? "var(--sl-green)"
                      : state === "running"
                        ? "var(--sl-indigo-2)"
                        : "var(--sl-fg-4)",
                }}
              >
                {state === "done" ? I.check(14) : state === "running" ? I.spinner(14) : I.dot(6)}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{s.t}</div>
                <div style={{ fontSize: 11.5, color: "var(--sl-fg-3)", marginTop: 2 }}>{s.d}</div>
              </div>
              <span style={{ fontSize: 11, color: "var(--sl-fg-4)" }}>
                {state === "done" ? "done" : state === "running" ? "running…" : "queued"}
              </span>
            </div>
          );
        })}
      </Card>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 24,
        }}
      >
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel and use my own agent
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!allDone}
          onClick={onDone}
          rightIcon={I.arrow(13)}
        >
          {allDone ? "Continue to deploy" : "Working…"}
        </Button>
      </div>
    </>
  );
}

// ─── Deploy step ────────────────────────────────────────────────────
function DeployStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  // Mock event detection: flip to "received" after a short delay so reviewers
  // can see both states without actually shipping code.
  const [received, setReceived] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReceived(true), 5500);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <StepHeader
        title="Deploy the code"
        sub={
          <>
            <p style={{ margin: 0 }}>
              Push the code to the production / sandbox environment as you do, or run it locally.
            </p>
            <p style={{ margin: "8px 0 0" }}>
              We'll tell you when we start receiving events from your code.
            </p>
          </>
        }
      />

      {received ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            border: "1px solid rgba(65,209,149,0.35)",
            background: "rgba(65,209,149,0.06)",
            borderRadius: 10,
          }}
        >
          <span style={{ color: "var(--sl-green)", display: "inline-flex" }}>{I.check(14)}</span>
          <div style={{ fontSize: 12.5, color: "var(--sl-fg-2)", flex: 1 }}>
            First event received from{" "}
            <span style={{ color: "var(--sl-fg)", fontWeight: 500 }}>acme/superlog-web</span>.
            You're flowing.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            border: "1px dashed var(--sl-line-2)",
            borderRadius: 10,
          }}
        >
          <span style={{ color: "var(--sl-indigo-2)", display: "inline-flex" }}>
            {I.spinner(14)}
          </span>
          <div style={{ fontSize: 12.5, color: "var(--sl-fg-2)", flex: 1 }}>
            Waiting for your first event…
          </div>
        </div>
      )}

      <StepFooter
        onSkip={received ? undefined : onSkip}
        skippable={!received}
        onNext={onNext}
        nextLabel={received ? "Continue" : "I've deployed"}
      />
    </>
  );
}

// ─── Onboarding container ───────────────────────────────────────────
export function Onboarding({
  onComplete,
  progressStyle = "dots",
}: {
  onComplete: (result: OnboardingResult) => void;
  progressStyle?: ProgressStyle;
}) {
  const [stepIdx, setStepIdx] = useState(0);
  const [wizard, setWizard] = useState(false);
  const [installSkipped, setInstallSkipped] = useState(false);
  const [deploy, setDeploy] = useState<{ shipped: boolean; skipped?: boolean }>({
    shipped: false,
  });

  const finish = (
    overrides: {
      installSkipped?: boolean;
      deployShipped?: boolean;
      deploySkipped?: boolean;
    } = {},
  ) => {
    const agent: AgentChoice = wizard ? "wizard" : "self";
    const installSkippedFinal = overrides.installSkipped ?? installSkipped;
    const deployShipped = overrides.deployShipped ?? deploy.shipped;
    const deploySkipped = overrides.deploySkipped ?? !!deploy.skipped;
    onComplete({
      agent,
      deploy: { shipped: deployShipped },
      // GitHub + Slack are no longer part of the main onboarding flow — they
      // surface as todos on the dashboard and the user reaches them via the
      // resume-onboarding side door. Initialise as "not connected".
      github: { connected: false, repos: [] },
      slack: { connected: false },
      mcp: false,
      installSkipped: installSkippedFinal,
      deploySkipped,
      githubSkipped: false,
      slackSkipped: false,
    });
  };

  // Steps: 0 install (or wizard), 1 deploy. GitHub + Slack live on the
  // dashboard as todos and reach the user via the resume-onboarding flow.
  let body: React.ReactNode = null;
  if (stepIdx === 0 && !wizard) {
    body = (
      <AgentStep
        onNext={() => {
          setInstallSkipped(false);
          setStepIdx(1);
        }}
        onWizard={() => setWizard(true)}
        onSkip={() => {
          setInstallSkipped(true);
          setStepIdx(1);
        }}
      />
    );
  } else if (stepIdx === 0 && wizard) {
    body = <WizardRunning onDone={() => setStepIdx(1)} onCancel={() => setWizard(false)} />;
  } else if (stepIdx === 1) {
    body = (
      <DeployStep
        onNext={() => {
          setDeploy({ shipped: true, skipped: false });
          finish({ deployShipped: true, deploySkipped: false });
        }}
        onSkip={() => {
          setDeploy({ shipped: false, skipped: true });
          finish({ deployShipped: false, deploySkipped: true });
        }}
      />
    );
  }

  if (progressStyle === "rail") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          background: "var(--sl-bg)",
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--sl-line)",
            position: "sticky",
            top: 0,
            height: "100vh",
          }}
        >
          <ProgressRail stepIdx={stepIdx} style="rail" />
          <div style={{ position: "absolute", bottom: 24, left: 28, right: 28 }}>
            <a
              href="https://docs.superlog.sh"
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: "var(--sl-fg-3)", textDecoration: "none" }}
            >
              Need help? <span style={{ color: "var(--sl-fg-2)" }}>docs.superlog.sh</span>{" "}
              <span style={{ color: "var(--sl-fg-4)" }}>↗</span>
            </a>
          </div>
        </aside>
        <main
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "64px 48px",
          }}
        >
          <div style={{ width: "100%", maxWidth: 640 }}>{body}</div>
        </main>
      </div>
    );
  }

  if (progressStyle === "top") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--sl-bg)" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 24px",
            borderBottom: "1px solid var(--sl-line)",
          }}
        >
          <Wordmark />
          <span style={{ fontSize: 12, color: "var(--sl-fg-3)" }}>Install</span>
        </header>
        <ProgressRail stepIdx={stepIdx} style="top" />
        <main style={{ display: "flex", justifyContent: "center", padding: "56px 32px" }}>
          <div style={{ width: "100%", maxWidth: 640 }}>{body}</div>
        </main>
      </div>
    );
  }

  // dots (default)
  return (
    <div style={{ minHeight: "100vh", background: "var(--sl-bg)" }}>
      <header
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          padding: "20px 32px",
        }}
      >
        <Wordmark />
        <ProgressRail stepIdx={stepIdx} style="dots" />
        <span />
      </header>
      <main style={{ display: "flex", justifyContent: "center", padding: "64px 32px" }}>
        <div style={{ width: "100%", maxWidth: 640 }}>{body}</div>
      </main>
    </div>
  );
}

// Used by the resume-onboarding flow on the dashboard.
export function ResumeOnboarding({
  which,
  onDone,
  onCancel,
}: {
  which: "install" | "github" | "slack";
  onDone: (patch: Partial<OnboardingResult>) => void;
  onCancel: () => void;
}) {
  const [github, setGithub] = useState<GithubData>({ sub: "connect" });
  const [slack, setSlack] = useState<SlackData>({ sub: "connect" });
  return (
    <div style={{ minHeight: "100vh", background: "var(--sl-bg)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 24px",
          borderBottom: "1px solid var(--sl-line)",
        }}
      >
        <Wordmark />
        <Button variant="ghost" size="sm" onClick={onCancel} leftIcon={I.x(12)}>
          Close
        </Button>
      </header>
      <main style={{ display: "flex", justifyContent: "center", padding: "56px 32px" }}>
        <div style={{ width: "100%", maxWidth: 640 }}>
          {which === "install" && (
            <AgentStep
              onNext={() => onDone({ installSkipped: false, agent: "self" })}
              onWizard={() => onDone({ installSkipped: false, agent: "wizard" })}
              onSkip={onCancel}
            />
          )}
          {which === "github" && (
            <GitHubStep
              data={github}
              onChange={setGithub}
              onNext={() =>
                onDone({
                  github: {
                    connected: true,
                    repos: github.repos || [],
                    org: github.org,
                  },
                  githubSkipped: false,
                })
              }
              onSkip={onCancel}
            />
          )}
          {which === "slack" && (
            <SlackStep
              data={slack}
              onChange={setSlack}
              onNext={() =>
                onDone({
                  slack: {
                    connected: true,
                    incidents: slack.incidents,
                    recap: slack.recap,
                  },
                  slackSkipped: false,
                })
              }
              onSkip={onCancel}
            />
          )}
        </div>
      </main>
    </div>
  );
}
