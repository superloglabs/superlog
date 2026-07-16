import { useEffect, useRef, useState } from "react";
import { OrgProjectSwitcher } from "../OrgProjectSwitcher.tsx";
import {
  type GithubInstallation,
  useClaimSignupIntent,
  useCreateKey,
  useCreateMyFirstOrg,
  useGithubInstallation,
  useSlackInstallation,
  useStartGithubInstall,
  useStartSlackInstall,
} from "../api.ts";
import { authClient, useSession } from "../auth-client.ts";
import { Wordmark } from "../design/ui.tsx";
import { getSkillOnboardingIntent } from "../skillOnboarding.ts";
import { AwsConnectFlow } from "./AwsConnectFlow.tsx";
import { CloudflareConnectFlow } from "./CloudflareConnectFlow.tsx";
import { ConnectDataChooser } from "./ConnectDataChooser.tsx";
import { GcpConnectFlow } from "./GcpConnectFlow.tsx";
import { RailwayConnectFlow } from "./RailwayConnectFlow.tsx";
import { RenderConnectFlow } from "./RenderConnectFlow.tsx";
import { VercelConnectFlow } from "./VercelConnectFlow.tsx";
import type { ConnectAction } from "./connectChoices.ts";
import { CheckIcon, GithubIcon, SlackIcon, SpinnerIcon } from "./icons.tsx";
import {
  type WebView,
  initialWebViewFromSearch,
  stripHandledOnboardingParams,
} from "./onboardingWebView.ts";
import {
  ExploreDemoLink,
  InstallPromptCard,
  SOFT_LINE,
  STRONG_LINE,
  StepFooter,
  StepHeader,
} from "./wizardChrome.tsx";

// Standalone fullscreen wizard shown to new users before they reach the
// dashboard. Mirrors the playground's Onboarding (dots variant):
//   Header: wordmark top-left, nothing else.
//   Body:   centered, max-w 640. Title + subtitle, step content, footer.
//   Footer: border-top, Skip and CTA right-aligned together.
//
// Steps:
//   1. Connect — pick a lane: the AWS / Cloudflare no-code integrations, or
//      "I'm hosted elsewhere", which opens the coding-agent prompt.
//   2. Install — copy a self-contained agent prompt with a fresh API key.
//   3. Deploy  — poll for first telemetry, advance once it arrives.
// Completion calls onComplete; the gate only allows it after telemetry arrives.

type Mode = "web" | "agent";

// The Cloudflare / Vercel OAuth callbacks redirect back to the app with
// `?cloudflare=...` / `?vercel=...`. When that lands we want to drop straight
// into the matching flow (which reads the outcome + install status), not the
// chooser — otherwise the user is bounced back to "Connect your data" and has
// to click the integration again to see progress. A Vercel `drains_unavailable`
// outcome is different: the API already learned the team can't use Drains, so
// route into the coding-agent prompt instead.
function initialWebView(): WebView {
  if (typeof window === "undefined") return "chooser";
  return initialWebViewFromSearch(window.location.search);
}

export function OnboardingWizard({
  mode = "web",
  projectId,
  hasIngested,
  userName,
  userEmail,
  onComplete,
  onExploreDemo,
}: {
  mode?: Mode;
  // Null until the user has created their first org. While null, the wizard
  // only renders the create-org step regardless of `mode`.
  projectId: string | null;
  // Whether the *real* project has ingested telemetry (from the proxy's
  // project-level marker). This is the honest "events arrived" signal — unlike the stats
  // endpoint, which is demo-overlaid for un-ingested projects and would otherwise
  // make the wizard claim "first events received" while showing demo data.
  hasIngested: boolean;
  userName: string;
  userEmail: string;
  onComplete: () => void;
  // Present only when a shared demo project is configured. Lets the user skip
  // ahead and explore sample data instead of instrumenting first.
  onExploreDemo?: () => void;
}) {
  const [webView, setWebView] = useState<WebView>(initialWebView);

  const createKey = useCreateKey(projectId ?? "");
  const github = useGithubInstallation();
  const slack = useSlackInstallation();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextSearch = stripHandledOnboardingParams(window.location.search);
    if (nextSearch === window.location.search) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch}${window.location.hash}`,
    );
  }, []);

  // Route a chooser selection to the matching view. AWS / Cloudflare / Vercel
  // get their no-code integration flows; "I'm hosted elsewhere" (action "code")
  // opens the coding-agent install prompt.
  const handlePick = (action: ConnectAction) => {
    if (action === "aws") {
      setWebView("aws");
    } else if (action === "cloudflare") {
      setWebView("cloudflare");
    } else if (action === "gcp") {
      setWebView("gcp");
    } else if (action === "vercel") {
      setWebView("vercel");
    } else if (action === "railway") {
      setWebView("railway");
    } else if (action === "render") {
      setWebView("render");
    } else {
      setWebView("code");
    }
  };

  // Mint exactly once per mount, and only after we have a project to mint into
  // *and* the user has chosen the coding-agent path — the no-code AWS /
  // Cloudflare integrations never use an ingest key, so minting on chooser
  // entry would leave an unused key on the project. The ref guard makes the
  // mint a strict per-mount one-shot, independent of mutation state identity or
  // polling re-renders.
  const minted = useRef(false);
  useEffect(() => {
    if (mode !== "web") return;
    if (webView !== "code") return;
    if (!projectId) return;
    if (minted.current) return;
    minted.current = true;
    createKey.mutate("Setup install");
  }, [mode, webView, projectId, createKey.mutate]);

  const eventsArrived = hasIngested;

  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="flex items-center justify-between px-8 py-5">
        <Wordmark size="md" />
        <div className="flex items-center gap-3">
          <OrgProjectSwitcher />
          <button
            type="button"
            onClick={async () => {
              await authClient.signOut();
              window.location.href = "/";
            }}
            className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex justify-center px-8 pb-16 pt-12">
        <div className="w-full max-w-[640px]">
          {!projectId ? (
            <CreateOrgStep userName={userName} userEmail={userEmail} />
          ) : mode === "agent" ? (
            <AgentSetupFlow
              projectId={projectId}
              github={github.data}
              githubLoading={github.isLoading}
              slack={slack.data}
              slackLoading={slack.isLoading}
              onDone={onComplete}
            />
          ) : webView === "chooser" ? (
            <ConnectDataChooser onPick={handlePick} onExploreDemo={onExploreDemo} />
          ) : webView === "aws" ? (
            <AwsConnectFlow
              projectId={projectId}
              onBack={() => setWebView("chooser")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
            />
          ) : webView === "cloudflare" ? (
            <CloudflareConnectFlow
              projectId={projectId}
              eventsArrived={eventsArrived}
              onBack={() => setWebView("chooser")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
            />
          ) : webView === "gcp" ? (
            <GcpConnectFlow
              projectId={projectId}
              eventsArrived={eventsArrived}
              onBack={() => setWebView("chooser")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
            />
          ) : webView === "vercel" ? (
            <VercelConnectFlow
              projectId={projectId}
              eventsArrived={eventsArrived}
              onBack={() => setWebView("chooser")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
              onDrainsUnavailable={() => setWebView("code")}
            />
          ) : webView === "railway" ? (
            <RailwayConnectFlow
              projectId={projectId}
              eventsArrived={eventsArrived}
              onBack={() => setWebView("chooser")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
            />
          ) : webView === "render" ? (
            <RenderConnectFlow
              projectId={projectId}
              eventsArrived={eventsArrived}
              onBack={() => setWebView("chooser")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
            />
          ) : webView === "code" ? (
            <InstallStep
              apiKey={createKey.data?.plaintext ?? null}
              minting={createKey.isPending && !createKey.data}
              error={createKey.error ? String(createKey.error) : null}
              onBack={() => setWebView("chooser")}
              onNext={() => setWebView("deploy")}
              onExploreDemo={onExploreDemo}
            />
          ) : (
            <DeployStep
              eventsArrived={eventsArrived}
              onBack={() => setWebView("code")}
              onDone={onComplete}
              onExploreDemo={onExploreDemo}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// Suggest an org name from whatever we know about the user. Google sign-in
// gives us a real display name ("Jane Doe"); email/password gives us nothing,
// so we fall back to the email local part.
function suggestedOrgName(userName: string, userEmail: string): string {
  const trimmedName = userName.trim();
  if (trimmedName) return `${trimmedName}'s org`;
  const local = userEmail.split("@")[0] ?? "";
  if (local) return `${local}'s org`;
  return "";
}

function CreateOrgStep({ userName, userEmail }: { userName: string; userEmail: string }) {
  const [name, setName] = useState(() => suggestedOrgName(userName, userEmail));
  const inputRef = useRef<HTMLInputElement>(null);
  const createOrg = useCreateMyFirstOrg();
  const trimmed = name.trim();
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = () => {
    if (!trimmed || createOrg.isPending) return;
    createOrg.mutate(trimmed);
    // Don't call onComplete; the /api/me invalidation will flip OnboardingGate
    // into the install step automatically once the new org is visible.
  };
  return (
    <>
      <StepHeader
        title="Name your organization"
        sub="This is the workspace your project and teammates will live in. You can rename it later."
      />
      <div>
        <label
          htmlFor="onboarding-org-name"
          className="block text-[11.5px] uppercase tracking-[0.08em] text-subtle"
        >
          Organization name
        </label>
        <input
          id="onboarding-org-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          disabled={createOrg.isPending}
          maxLength={80}
          placeholder="Acme"
          className="mt-2 block w-full rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#0f1014] px-3 py-2 text-[14px] text-fg outline-none transition-colors focus:border-[#8C98F0] disabled:opacity-60"
        />
        {createOrg.error && (
          <p className="m-0 mt-2 text-[12.5px] text-danger">{String(createOrg.error)}</p>
        )}
      </div>
      <StepFooter
        onNext={submit}
        nextLabel={createOrg.isPending ? "Creating…" : "Create organization"}
        nextDisabled={!trimmed || createOrg.isPending}
      />
    </>
  );
}

function hasGithubPermissions(installation: GithubInstallation | undefined): boolean {
  if (!installation?.installed) return false;
  if (installation.repoVerificationUnavailable) return true;
  return installation.repos.some((repo) => repo.enabled);
}

function AgentSetupFlow({
  projectId,
  github,
  githubLoading,
  slack,
  slackLoading,
  onDone,
}: {
  projectId: string;
  github: GithubInstallation | undefined;
  githubLoading: boolean;
  slack: ReturnType<typeof useSlackInstallation>["data"];
  slackLoading: boolean;
  onDone: () => void;
}) {
  useSession();
  const startGithub = useStartGithubInstall();
  const startSlack = useStartSlackInstall();
  const claimIntent = useClaimSignupIntent(projectId);
  const githubReady = hasGithubPermissions(github);
  const slackInstall = slack?.installed ? slack : null;
  const [slackSkipped, setSlackSkipped] = useState(false);
  const slackReady = !!slackInstall || slackSkipped;
  // GitHub user-OAuth chained-into-App-install happens in Phase D; for now we
  // always show the install button, even for users who signed in with GitHub.
  const signedInWithGithub = false;
  const [intentId] = useState(() => getSkillOnboardingIntent());

  useEffect(() => {
    if (!githubReady || !slackReady || !intentId || claimIntent.data || claimIntent.isPending)
      return;
    claimIntent.mutate(intentId);
  }, [githubReady, slackReady, intentId, claimIntent]);

  if (!githubReady) {
    return (
      <IntegrationStep
        icon={<GithubIcon size={18} />}
        title="Connect GitHub"
        sub={
          signedInWithGithub
            ? "You're signed in with GitHub. Superlog still needs app permissions on at least one repo before your agent can continue."
            : "Install the GitHub app so Superlog can inspect your repo and open PRs."
        }
        body="Choose the repositories you want Superlog to work with. At least one enabled repo is required."
        loading={githubLoading || startGithub.isPending}
        cta={signedInWithGithub ? "Grant repo access" : "Connect GitHub"}
        onNext={() =>
          startGithub.mutate(undefined, {
            onSuccess: ({ url }) => window.location.assign(url),
          })
        }
      />
    );
  }

  if (!slackReady) {
    return (
      <IntegrationStep
        icon={<SlackIcon size={18} />}
        title="Connect Slack"
        sub="Connect Slack so fix PRs and incident updates can reach your team."
        body="After Slack is connected, we'll finish setup and send you back to your agent."
        loading={slackLoading || startSlack.isPending}
        cta="Connect Slack"
        onNext={() =>
          startSlack.mutate(undefined, {
            onSuccess: ({ url }) => window.location.assign(url),
          })
        }
        onSkip={() => setSlackSkipped(true)}
        skipLabel="Skip for now"
      />
    );
  }

  return (
    <AgentKeyStep
      githubLabel={githubReady && github?.installed ? github.accountLogin : null}
      slackLabel={slackInstall?.teamName ?? null}
      slackSkipped={slackSkipped && !slackInstall}
      keyPrefix={claimIntent.data?.keyPrefix ?? null}
      returnTo={claimIntent.data?.returnTo ?? null}
      claiming={claimIntent.isPending}
      error={
        !intentId
          ? "Missing signup intent. Restart signup from your agent."
          : claimIntent.error
            ? String(claimIntent.error)
            : null
      }
      onDone={onDone}
    />
  );
}

function IntegrationStep({
  icon,
  title,
  sub,
  body,
  loading,
  cta,
  onNext,
  onSkip,
  skipLabel,
}: {
  icon: React.ReactNode;
  title: string;
  sub: React.ReactNode;
  body: string;
  loading: boolean;
  cta: string;
  onNext: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <>
      <StepHeader title={title} sub={sub} />
      <div className={`overflow-hidden rounded-[14px] border bg-[#0a0a0c] ${SOFT_LINE}`}>
        <div className={`flex items-center gap-2.5 border-b px-[18px] py-[12px] ${SOFT_LINE}`}>
          <span className="ml-0 text-[11px] uppercase tracking-[0.08em] text-subtle">
            agent setup
          </span>
        </div>
        <div className="flex items-start gap-3 px-[22px] py-[18px]">
          <span className="mt-0.5 text-fg">{icon}</span>
          <p className="m-0 flex-1 text-[13.5px] leading-[1.5] text-muted">{body}</p>
        </div>
      </div>
      <StepFooter
        onNext={onNext}
        nextLabel={loading ? "Connecting..." : cta}
        nextDisabled={loading}
        onSkip={onSkip}
        skipLabel={skipLabel}
      />
    </>
  );
}

export function AgentKeyStep({
  githubLabel,
  slackLabel,
  slackSkipped = false,
  keyPrefix,
  returnTo,
  claiming,
  error,
  onDone,
}: {
  githubLabel: string | null;
  slackLabel: string | null;
  slackSkipped?: boolean;
  keyPrefix: string | null;
  returnTo: string | null;
  claiming: boolean;
  error: string | null;
  onDone: () => void;
}) {
  const ready = !!keyPrefix && !claiming && !error;
  const [closeAttempted, setCloseAttempted] = useState(false);

  function backToAgent() {
    const agentReturnTo = getAgentReturnTo(returnTo);
    if (agentReturnTo) {
      onDone();
      window.location.assign(agentReturnTo);
      return;
    }
    window.close();
    setCloseAttempted(true);
  }

  return (
    <div className="relative">
      {ready && <ConfettiBurst />}
      <StepHeader
        title={ready ? "Congrats!" : "Finishing setup"}
        sub={
          ready
            ? "We've registered the key that your agent is working with."
            : slackSkipped
              ? "GitHub is connected. We're registering the ingest key your agent generated to this project. You can connect Slack later from settings."
              : "GitHub and Slack are connected. We're registering the ingest key your agent generated to this project."
        }
      />
      {ready ? (
        <AgentDeployReadyPanel />
      ) : (
        <div className={`overflow-hidden rounded-[14px] border bg-[#0a0a0c] ${SOFT_LINE}`}>
          <div
            className={`grid grid-cols-1 gap-2 border-b px-[18px] py-[12px] ${SOFT_LINE} sm:grid-cols-2`}
          >
            <StatusPill icon={<GithubIcon size={13} />} label={githubLabel ?? "GitHub connected"} />
            {slackSkipped ? (
              <SkippedPill icon={<SlackIcon size={13} />} label="Slack skipped" />
            ) : (
              <StatusPill icon={<SlackIcon size={13} />} label={slackLabel ?? "Slack connected"} />
            )}
          </div>
          <div className="px-[22px] py-[18px]">
            {claiming ? (
              <p className="m-0 inline-flex items-center gap-2 text-[13px] text-muted">
                <SpinnerIcon size={13} /> Registering the agent's API key...
              </p>
            ) : error ? (
              <p className="m-0 text-[13px] text-danger">{error}</p>
            ) : null}
          </div>
        </div>
      )}
      {closeAttempted && (
        <p className="mt-3 text-right text-[12px] text-muted">
          If the tab stays open, return to your agent manually.
        </p>
      )}
      <StepFooter onNext={backToAgent} nextLabel="Back to agent" nextDisabled={!ready} />
    </div>
  );
}

function getAgentReturnTo(returnTo: string | null): string | null {
  if (!returnTo || typeof window === "undefined") return null;
  try {
    const url = new URL(returnTo, window.location.href);
    if (url.origin === window.location.origin) return null;
    if (url.protocol === "javascript:" || url.protocol === "data:" || url.protocol === "blob:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function AgentDeployReadyPanel() {
  return (
    <div className={`overflow-hidden rounded-[14px] border bg-[#0a0a0c] ${SOFT_LINE}`}>
      <div className={`border-b px-[22px] py-[18px] ${SOFT_LINE}`}>
        <p className="m-0 text-[13.5px] leading-[1.55] text-fg">
          Your agent is wiring up the application now.
        </p>
        <p className="m-0 mt-2 text-[13.5px] leading-[1.55] text-muted">
          Once it's done, you can inspect its work. Don't forget to deploy the instrumented code!
        </p>
      </div>
      <div className="px-[22px] py-[18px]">
        <div
          className={`flex items-center gap-2.5 rounded-[10px] border border-dashed px-4 py-3 ${STRONG_LINE}`}
        >
          <span className="text-[#8C98F0]">
            <SpinnerIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] leading-[1.5] text-muted">
            We'll tell you once we receive first telemetry from you.
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfettiBurst() {
  const pieces = [
    ["8%", "8%", "#41D195", "0ms", "14deg"],
    ["18%", "0%", "#8C98F0", "80ms", "-18deg"],
    ["31%", "7%", "#F7C948", "150ms", "26deg"],
    ["46%", "-2%", "#FF6B9A", "40ms", "-32deg"],
    ["59%", "6%", "#52D1F6", "120ms", "21deg"],
    ["73%", "0%", "#F7C948", "210ms", "-16deg"],
    ["87%", "8%", "#41D195", "70ms", "30deg"],
    ["12%", "28%", "#FF6B9A", "230ms", "-24deg"],
    ["83%", "30%", "#8C98F0", "180ms", "18deg"],
  ];

  return (
    <div
      className="pointer-events-none absolute -top-8 left-0 right-0 h-32 overflow-hidden"
      aria-hidden="true"
    >
      <style>{`
        @keyframes agent-confetti-fall {
          0% { opacity: 0; transform: translateY(-10px) rotate(0deg) scale(0.85); }
          18% { opacity: 1; }
          100% { opacity: 0; transform: translateY(92px) rotate(220deg) scale(1); }
        }
      `}</style>
      {pieces.map(([left, top, color, delay, rotate], i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative confetti set.
          key={i}
          className="absolute h-2.5 w-1.5 rounded-[2px]"
          style={{
            left,
            top,
            backgroundColor: color,
            transform: `rotate(${rotate})`,
            animation: `agent-confetti-fall 1600ms ease-out ${delay} 1 both`,
          }}
        />
      ))}
    </div>
  );
}

function StatusPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-[rgba(65,209,149,0.24)] bg-[rgba(65,209,149,0.06)] px-3 py-2 text-[12px] text-fg">
      <span className="text-success">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function SkippedPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] px-3 py-2 text-[12px] text-muted">
      <span className="text-subtle">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function InstallStep({
  apiKey,
  minting,
  error,
  onBack,
  onNext,
  onExploreDemo,
}: {
  apiKey: string | null;
  minting: boolean;
  error: string | null;
  onBack?: () => void;
  onNext: () => void;
  onExploreDemo?: () => void;
}) {
  return (
    <>
      <StepHeader
        title="Install Superlog"
        sub="Paste this prompt in Cursor, Claude Code, Codex, or any agent. It runs the install skill end-to-end — adds the SDK, instruments your code, opens a PR."
      />

      <InstallPromptCard apiKey={apiKey} minting={minting} error={error} />

      <StepFooter onBack={onBack} onNext={onNext} nextLabel="The agent is done" />
      <ExploreDemoLink onExploreDemo={onExploreDemo} />
    </>
  );
}

function DeployStep({
  eventsArrived,
  onBack,
  onDone,
  onExploreDemo,
}: {
  eventsArrived: boolean;
  onBack: () => void;
  onDone: () => void;
  onExploreDemo?: () => void;
}) {
  return (
    <>
      <StepHeader
        title="Deploy the code"
        sub={
          <>
            <p className="m-0">
              Push the code to the production / sandbox environment as you do, or run it locally.
            </p>
            <p className="m-0 mt-2">
              We'll tell you when we start receiving events from your code.
            </p>
          </>
        }
      />

      {eventsArrived ? (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-[rgba(65,209,149,0.35)] bg-[rgba(65,209,149,0.06)] px-4 py-3">
          <span className="text-success">
            <CheckIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] text-fg">
            First event received. <span className="text-muted">You're flowing.</span>
          </div>
        </div>
      ) : (
        <div
          className={`flex items-center gap-2.5 rounded-[10px] border border-dashed px-4 py-3 ${STRONG_LINE}`}
        >
          <span className="text-[#8C98F0]">
            <SpinnerIcon size={14} />
          </span>
          <div className="flex-1 text-[12.5px] text-muted">Waiting for your first event…</div>
        </div>
      )}

      <StepFooter
        onBack={onBack}
        onNext={onDone}
        nextLabel={eventsArrived ? "Continue" : "I've deployed"}
        nextDisabled={!eventsArrived}
      />
      {!eventsArrived && <ExploreDemoLink onExploreDemo={onExploreDemo} />}
    </>
  );
}
