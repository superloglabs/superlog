import { type ReactNode, useEffect, useState } from "react";
import { useMe } from "../api.ts";
import { CenteredShell } from "../design/ui.tsx";
import { finishSkillOnboarding, isSkillOnboardingPending } from "../skillOnboarding.ts";
import { OnboardingWizard } from "./OnboardingWizard.tsx";

// Pre-empts the dashboard for new users until they've finished the install +
// deploy wizard and telemetry has arrived.
//
// We auto-pass-through once the project has ever ingested. `hasIngested` is
// derived from api_keys.last_used_at (the proxy stamps it on every successful
// auth), so this gate stays cheap: no ClickHouse queries per page load.

export function OnboardingGate({ children }: { children: ReactNode }) {
  const me = useMe();

  const [dismissed, setDismissed] = useState(false);

  const hasIngested = me.data?.project?.hasIngested ?? false;
  const skillMode = isSkillOnboardingPending();

  useEffect(() => {
    if (skillMode && hasIngested) finishSkillOnboarding();
  }, [skillMode, hasIngested]);

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

  return (
    <OnboardingWizard
      projectId={me.data.project.id}
      userName={me.data.user.name}
      userEmail={me.data.user.email}
      onComplete={() => {
        setDismissed(true);
      }}
    />
  );
}
