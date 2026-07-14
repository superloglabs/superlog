import { type ReactNode, useEffect, useState } from "react";
import { useMe } from "../api.ts";
import { CenteredShell } from "../design/ui.tsx";
import { finishSkillOnboarding, isSkillOnboardingPending } from "../skillOnboarding.ts";
import { OnboardingWizard } from "./OnboardingWizard.tsx";
import {
  DemoExplorationProvider,
  readDemoExploring,
  writeDemoExploring,
} from "./demoExploration.tsx";

// Pre-empts the dashboard for new users until they've finished the install +
// deploy wizard and telemetry has arrived.
//
// We auto-pass-through once the project has ever ingested. `hasIngested` is
// derived from the proxy's project-level telemetry marker, so this gate stays
// cheap: no ClickHouse queries per page load.
//
// Demo overlay: when the server is serving sample data (`me.demoMode`), the
// install wizard stays the default landing, but the user can opt to "Explore
// with sample data" — which renders the populated app (reading the shared demo
// project, read-only) with a persistent connect banner in the overview setup
// slot. The opt-in is local-only and is dropped the instant real telemetry lands
// (demoMode flips false).

export function OnboardingGate({ children }: { children: ReactNode }) {
  const me = useMe();

  const [dismissed, setDismissed] = useState(false);
  const [exploring, setExploring] = useState(readDemoExploring);

  const hasIngested = me.data?.project?.hasIngested ?? false;
  const demoMode = me.data?.demoMode ?? false;
  const skillMode = isSkillOnboardingPending();

  useEffect(() => {
    if (skillMode && hasIngested) finishSkillOnboarding();
  }, [skillMode, hasIngested]);

  // Teleport: once the user's own telemetry arrives, demo mode is over — drop
  // the local opt-in so refreshes land straight on their real data. Gate on
  // `me.data` being loaded: before it resolves, `demoMode` defaults to false,
  // and acting on that would wipe a returning explorer's opt-in on every refresh.
  useEffect(() => {
    if (me.data && !demoMode && exploring) {
      setExploring(false);
      writeDemoExploring(false);
    }
  }, [me.data, demoMode, exploring]);

  const startExploring = () => {
    setExploring(true);
    writeDemoExploring(true);
  };
  const stopExploring = () => {
    setExploring(false);
    writeDemoExploring(false);
  };
  const demoExploration = {
    demoMode,
    exploring: demoMode && exploring,
    stopExploring,
  };

  if (me.isLoading || !me.data) {
    return (
      <CenteredShell>
        <div className="text-[12px] uppercase tracking-[0.08em] text-subtle">loading…</div>
      </CenteredShell>
    );
  }

  // Pre-org user: just signed up, hasn't created their first org yet. The
  // wizard's create-org step is the only thing they can do until they do.
  if (!me.data.org || !me.data.project) {
    return (
      <OnboardingWizard
        mode={skillMode ? "agent" : "web"}
        projectId={null}
        hasIngested={hasIngested}
        userName={me.data.user.name}
        userEmail={me.data.user.email}
        onComplete={() => {
          if (skillMode) finishSkillOnboarding();
          setDismissed(true);
        }}
      />
    );
  }

  if (skillMode && !hasIngested) {
    return (
      <OnboardingWizard
        mode="agent"
        projectId={me.data.project.id}
        hasIngested={hasIngested}
        userName={me.data.user.name}
        userEmail={me.data.user.email}
        onComplete={() => {
          finishSkillOnboarding();
          setDismissed(true);
        }}
      />
    );
  }

  if (hasIngested || dismissed) {
    return <>{children}</>;
  }

  // Opted into the demo: render the populated app (server serves demo data,
  // read-only). The overview setup slot renders the persistent connect nudge.
  if (demoMode && exploring) {
    return <DemoExplorationProvider value={demoExploration}>{children}</DemoExplorationProvider>;
  }

  return (
    <OnboardingWizard
      projectId={me.data.project.id}
      hasIngested={hasIngested}
      userName={me.data.user.name}
      userEmail={me.data.user.email}
      onComplete={() => {
        setDismissed(true);
      }}
      onExploreDemo={demoMode ? startExploring : undefined}
    />
  );
}
