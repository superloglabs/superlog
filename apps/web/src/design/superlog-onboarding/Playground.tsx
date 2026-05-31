import { useState } from "react";
import { Dashboard } from "./Dashboard.tsx";
import { Onboarding, ResumeOnboarding } from "./Onboarding.tsx";
import type { OnboardingResult } from "./types.ts";

type Phase = "onboarding" | "dashboard" | "onboarding-resume";

// Self-contained playground for the Superlog onboarding + dashboard design.
// Mocks all data — no GitHub/Slack/Clerk wiring. Intended for /design/onboarding.
export function SuperlogOnboardingPlayground() {
  const [phase, setPhase] = useState<Phase>("onboarding");
  const [onboardingResult, setOnboardingResult] = useState<OnboardingResult | null>(null);
  const [resumeStep, setResumeStep] = useState<"install" | "github" | "slack" | null>(null);

  const handleComplete = (result: OnboardingResult) => {
    setOnboardingResult(result);
    setPhase("dashboard");
  };

  const handleResumeOnboarding = (which: "install" | "github" | "slack") => {
    setResumeStep(which);
    setPhase("onboarding-resume");
  };

  return (
    <div className="sl-onb-root">
      <SuperlogOnboardingStyles />

      {phase === "onboarding" && <Onboarding onComplete={handleComplete} progressStyle="dots" />}

      {phase === "onboarding-resume" && resumeStep && (
        <ResumeOnboarding
          which={resumeStep}
          onDone={(patch) => {
            setOnboardingResult((prev) =>
              prev ? { ...prev, ...patch } : (patch as OnboardingResult),
            );
            setPhase("dashboard");
            setResumeStep(null);
          }}
          onCancel={() => {
            setPhase("dashboard");
            setResumeStep(null);
          }}
        />
      )}

      {phase === "dashboard" && (
        <Dashboard
          onboardingState={onboardingResult ?? {}}
          onResumeOnboarding={handleResumeOnboarding}
        />
      )}

      {phase === "dashboard" && (
        <DemoControls
          onRestart={() => {
            setOnboardingResult(null);
            setPhase("onboarding");
          }}
          onSkipAll={() => {
            setOnboardingResult({
              agent: "self",
              deploy: { shipped: false },
              github: { connected: false, repos: [] },
              slack: { connected: false },
              mcp: false,
              installSkipped: true,
              deploySkipped: true,
              githubSkipped: true,
              slackSkipped: true,
            });
          }}
        />
      )}
      {phase === "onboarding" && (
        <DemoControls
          onSkipToDashboard={() => {
            setOnboardingResult({
              agent: "self",
              deploy: { shipped: true },
              github: {
                connected: true,
                repos: ["acme/superlog-web", "acme/api-gateway"],
              },
              slack: {
                connected: true,
                incidents: { enabled: true, channel: "eng-incidents" },
                recap: { enabled: true, channel: "eng" },
              },
              mcp: false,
              installSkipped: false,
              deploySkipped: false,
              githubSkipped: false,
              slackSkipped: false,
            });
            setPhase("dashboard");
          }}
        />
      )}
    </div>
  );
}

// Tiny floating jumper so reviewers can hop between phases without stepping
// through the whole flow. Replaces the prototype's tweaks-panel.
function DemoControls({
  onRestart,
  onSkipToDashboard,
  onSkipAll,
}: {
  onRestart?: () => void;
  onSkipToDashboard?: () => void;
  onSkipAll?: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        display: "flex",
        gap: 6,
        padding: 6,
        background: "var(--sl-surface)",
        border: "1px solid var(--sl-line)",
        borderRadius: 8,
        zIndex: 50,
        fontSize: 11,
      }}
    >
      {onRestart && <DemoButton onClick={onRestart}>restart</DemoButton>}
      {onSkipToDashboard && <DemoButton onClick={onSkipToDashboard}>skip to dashboard</DemoButton>}
      {onSkipAll && <DemoButton onClick={onSkipAll}>all skipped</DemoButton>}
    </div>
  );
}

function DemoButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const setHover = (hover: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = hover ? "rgba(255,255,255,0.05)" : "transparent";
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={setHover(true)}
      onMouseLeave={setHover(false)}
      style={demoBtnStyle}
    >
      {children}
    </button>
  );
}

const demoBtnStyle: React.CSSProperties = {
  padding: "4px 8px",
  background: "transparent",
  border: 0,
  color: "var(--sl-fg-3)",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
  borderRadius: 4,
};

// Scoped CSS variables and global font import. Inlined so the playground is
// fully self-contained — uses `--sl-*` so it never collides with the host
// app's `--color-*` tokens.
function SuperlogOnboardingStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      .sl-onb-root {
        --sl-bg: #141414;
        --sl-bg-elev: #0c0c0d;
        --sl-surface: #111113;
        --sl-surface-2: #161618;
        --sl-line: rgba(255,255,255,0.07);
        --sl-line-2: rgba(255,255,255,0.12);
        --sl-fg: #f5f5f6;
        --sl-fg-2: #c7c7cc;
        --sl-fg-3: #8a8a8f;
        --sl-fg-4: #5a5a60;
        /* Softer indigo than the host app's #435aea — that read too blue
           against this dark canvas. Closer to the original prototype. */
        --sl-indigo: #485ae2;
        --sl-indigo-2: #8C98F0;
        --sl-indigo-soft: rgba(72,90,226,0.14);
        --sl-indigo-line: rgba(72,90,226,0.35);
        --sl-green: #41d195;
        --sl-amber: #e7b15a;
        --sl-red: #ef5a6f;
        --sl-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
        background: var(--sl-bg);
        color: var(--sl-fg);
        font-family: var(--sl-sans);
        font-size: 14px;
        line-height: 1.5;
        letter-spacing: -0.005em;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
      }
      .sl-onb-root *, .sl-onb-root *::before, .sl-onb-root *::after { box-sizing: border-box; }
      .sl-onb-root .sl-onb-tiny {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--sl-fg-3);
      }
      .sl-onb-root ::selection { background: var(--sl-indigo-soft); }
      .sl-onb-root ::-webkit-scrollbar { width: 8px; height: 8px; }
      .sl-onb-root ::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.08);
        border-radius: 4px;
      }
      .sl-onb-root ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }
      .sl-onb-root ::-webkit-scrollbar-track { background: transparent; }
      @keyframes sl-onb-cursor { 50% { opacity: 0; } }
    `}</style>
  );
}
