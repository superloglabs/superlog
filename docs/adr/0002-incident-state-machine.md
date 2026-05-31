# ADR 0002: Incident State Machine

- Status: Accepted
- Date: 2026-05-21
- Updated: 2026-05-22 (reconciled with the worker implementation and runner backend seam)

## Context

Incidents are the durable user-facing object. Agent runs are execution attempts
against an incident. Runner backends can change, but the incident lifecycle must
stay stable: Slack threads, issue grouping, PR webhooks, and dashboard timelines
all reason about incidents rather than provider sessions.

## Decision

The incident state machine is:

`open | resolved | autoresolved_noise | merged`

`open` is the only active state. `resolved`, `autoresolved_noise`, and `merged`
are closed states with different recurrence behavior.

Legal transitions:

- `create -> open`: a new grouped issue creates an incident.
- `open -> open`: the agent updates title/severity/findings as evidence becomes clear; new issues can join the incident and emit `incident_context_changed`.
- `open -> autoresolved_noise`: the agent completes with `noiseClassification`, meaning the signal is real telemetry but does not represent actionable customer impact.
- `open -> resolved`: a human resolves it, an agent PR merges, autorecovery is confirmed, or the agent completes with `resolutionClassification`.
- `open -> merged`: an agent run determines another open incident is the live incident for the same root cause.
- `resolved | merged -> open`: a linked issue regresses; old resolution metadata is cleared and a new agent run can start.
- `autoresolved_noise -> autoresolved_noise`: recurrence updates `lastSeen` but does not reopen automatically.

Resolution outcomes map as follows:

- Agent opens PR: agent run completes with a PR; incident stays `open` until the PR merge webhook moves it to `resolved`.
- Agent says noise: incident moves to `autoresolved_noise`.
- Resolved by external action: agent completes with `resolutionClassification.reason = upstream_recovered` or a human/autorecovery path resolves it.
- Transient and will not appear again: agent completes with `resolutionClassification.reason = transient_condition_cleared`; incident moves to `resolved`.
- Manual action needed: agent run completes without a PR or resolution classification, usually with a Linear ticket or summary; incident stays `open`.

Interactions:

- Slack human replies on an `awaiting_human` agent run become `human_reply` events and resume the same runner session.
- New issues that join an active incident emit `incident_context_changed`; an idle runner session is steered with that delta instead of creating a parallel run.
- Regressions on `resolved` or `merged` incidents reopen the incident and allow a fresh agent run. Regressions on `autoresolved_noise` incidents stay noise.
- Agent PR webhooks record PR lifecycle events. A merge resolves the incident. Review comments and PR comments are currently captured as feedback; turning them into automatic agent follow-up work is a follow-up.

## Implementation

The incident lifecycle lives in `packages/db/src/resolve-incident.ts` behind
`createIncidentLifecycle()`. That module owns the incident state set, legal
transition guards, incident lifecycle events, creation, agent-result flattening,
noise classification, resolution, merge mutation helpers, and reopen cleanup.

The agent-run lifecycle lives separately in `apps/worker/src/agent-run.ts`. It
owns `agent_runs.state` and run-scoped audit events only.

Runner backend calls live behind `apps/worker/src/agent-runner-backend.ts`.
The worker orchestrator asks a backend to start, collect, steer, and resume a
session. The first adapter delegates to Anthropic Managed Agents, but incident
state transitions are decided from the normalized `AgentRunResult`, not from
Anthropic-specific session state. A future backend must satisfy that interface
and return the same result contract.

## Consequences

- Changing the runner backend should not require changing incident status rules.
- Incident timelines remain stable across Slack, GitHub, grouping, and agent-run paths.
- The one intentional gap is PR review follow-up automation: comments are persisted as feedback today, but the agent does not yet automatically address bot/human PR questions with commits.
