// Pure logic for the AWS connect onboarding flow, split out from the component
// so the phase/state mapping is unit-testable. Types are imported `type`-only so
// nothing from api.ts (React Query, browser globals) is pulled in at runtime.
import type {
  CloudConnection,
  CloudConnectionStatus,
  StackComponent,
  StackComponentState,
} from "../api.ts";

// Mirror of the API's region guard (`/^[a-z0-9-]{1,32}$/`). Validated client-side
// so a malformed custom region never produces a redirecting launch URL. The
// offered region list lives in ../awsRegions.ts (shared with settings).
const REGION_RE = /^[a-z0-9-]{1,32}$/;
export function isValidRegion(region: string): boolean {
  return REGION_RE.test(region);
}

// The step the AWS flow is on, derived from the connection + whether telemetry
// has started flowing. Drives which panel renders and whether "Continue" unlocks.
//   start      — no connection yet; show region picker + Connect button.
//   launching  — connection exists but isn't verified; the CloudFormation stack
//                is deploying (or the user still needs to paste the role ARN).
//   connected  — role verified; waiting for the first events to stream in.
//   flowing    — this connection's CloudWatch stream has delivered; complete.
export type AwsPhase = "start" | "launching" | "connected" | "flowing";

export function awsPhase(input: {
  connection: Pick<CloudConnection, "status"> | null;
  streamFlowing: boolean;
}): AwsPhase {
  const { connection, streamFlowing } = input;
  if (!connection) return "start";
  if (connection.status !== "connected") return "launching";
  return streamFlowing ? "flowing" : "connected";
}

// Whether *this AWS connection* has actually delivered telemetry, derived from
// its own stack-health stream components — not project-wide stats. Using project
// stats would let pre-existing agent/SDK data unlock the flow before the AWS
// CloudWatch stream has sent anything. A metric or log stream in `working` state
// means its dedicated ingest key was used recently (real Firehose delivery).
export function awsStreamFlowing(
  components: Pick<StackComponent, "key" | "state">[] | undefined,
): boolean {
  return (
    components?.some((c) => (c.key === "metrics" || c.key === "logs") && c.state === "working") ??
    false
  );
}

// "Continue" only unlocks once real telemetry is flowing — same poll-to-unblock
// contract as the coding-agent deploy step and OnboardingGate's `hasIngested`.
export function canContinueAws(phase: AwsPhase): boolean {
  return phase === "flowing";
}

// Tone for a stack-health component pill. Maps the API's StackComponentState to
// the design system's chip tones (see design/ui.tsx `ChipTone`).
export type ComponentTone = "muted" | "warning" | "success" | "danger";
export function stackComponentTone(state: StackComponentState): ComponentTone {
  switch (state) {
    case "working":
      return "success";
    case "pending":
      return "warning";
    case "broken":
      return "danger";
    default:
      return "muted"; // "missing"
  }
}

// Short human label for a connection's status, including the failure reason.
export function connectionStatusText(
  status: CloudConnectionStatus,
  lastError: string | null,
): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "pending":
      return "Waiting for the stack…";
    case "account_mismatch":
      return "Account mismatch — re-launch the stack in the right account";
    case "failed":
      return lastError ? `Couldn't verify: ${lastError}` : "Verification failed";
    default:
      return status;
  }
}

// Pick the connection the onboarding flow should track: the most recently
// created non-revoked row. (The list endpoint already filters revoked rows, but
// a project can briefly hold more than one while a prior pending attempt lingers.)
export function activeConnection<T extends { createdAt: string }>(
  connections: T[] | undefined,
): T | null {
  if (!connections || connections.length === 0) return null;
  return [...connections].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
