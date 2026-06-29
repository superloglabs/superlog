// Pure logic for the AWS connect onboarding flow, split out from the component
// so the phase/state mapping is unit-testable. Types are imported `type`-only so
// nothing from api.ts (React Query, browser globals) is pulled in at runtime.
import type { CloudConnection, CloudConnectionStatus, StackComponentState } from "../api.ts";

// Regions offered in the picker. The launch URL interpolates the region into the
// CloudFormation console hostname, so it must satisfy the API's validation
// (see `createSchema` in cloud-connections.ts).
export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "sa-east-1",
] as const;

export type AwsRegion = (typeof AWS_REGIONS)[number];
export const DEFAULT_AWS_REGION: AwsRegion = "us-east-1";

// Mirror of the API's region guard (`/^[a-z0-9-]{1,32}$/`). Validated client-side
// so a malformed custom region never produces a redirecting launch URL.
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
//   flowing    — events have arrived; onboarding can complete.
export type AwsPhase = "start" | "launching" | "connected" | "flowing";

export function awsPhase(input: {
  connection: Pick<CloudConnection, "status"> | null;
  eventsArrived: boolean;
}): AwsPhase {
  const { connection, eventsArrived } = input;
  if (!connection) return "start";
  if (connection.status !== "connected") return "launching";
  return eventsArrived ? "flowing" : "connected";
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
