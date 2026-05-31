# ADR 0001: Agent-Run Loop For New Issues

- Status: Accepted
- Date: 2026-04-24
- Updated: 2026-05-21 (renamed terminology from "investigation" to "agent run" — see [Merge incidents and investigations](#may-2026-update-merge-incidents--agent-runs) below)

## Context

Superlog already fingerprints raw telemetry into deterministic issues, but the product promise is broader than issue detection. The system needs to turn fresh production regressions into a managed agent-run loop that can:

- dedupe related issue reports into a single incident,
- run the agent against the right customer repository,
- open a PR only when a rule-based confidence gate is satisfied,
- fall back to human input in Slack when the agent gets blocked,
- resume the same run after a human reply without losing context.

The main design constraint is that the agent runtime must support long-lived, event-driven sessions with built-in code tools and pause/resume semantics that fit a Slack thread.

## Decision

Superlog will model the workflow as:

`issue -> incident -> agent run -> PR or human handoff`

### Provider boundary

The runtime stays behind an agent-run adapter boundary, but the first implementation uses Anthropic Managed Agents.

Reasons:

- managed sessions are event-driven and can be steered with follow-up messages,
- the runtime includes built-in file and shell tools inside an isolated environment,
- idle checkpointing is a better fit for Slack pause/resume than an executor-driven shell loop,
- OpenAI remains viable later, but would be a second adapter using Responses shell, remote MCP, and human-in-the-loop resume support rather than the first implementation path.

### Incident grouping

Agent runs run at the incident level, not the issue level.

V1 grouping is intentionally conservative. A `new` or `regressed` issue joins an open incident only when all of the following are true:

- same project,
- same service when service is known,
- incident first-seen time within a 15-minute grouping window,
- at least 2 shared normalized stack frames from the top 5 frames.

Otherwise a new incident is created.

### Persistence model

`issues` is extended with:

- `normalizedFrames jsonb`
- `lastSample jsonb`

New tables:

- `incidents`
- `incident_issues`
- `project_automation_settings`
- `agent_runs` (originally `investigations`)
- `incident_events` (originally `investigation_events`)

State machines:

- incidents: `open | resolved | ignored`
- agent runs: `queued | repo_discovery | running | awaiting_human | complete | failed`

The agent-run state machine, the legal transition graph, and the
matching audit-event kinds live in `apps/worker/src/agent-run.ts`. That
module is the only thing that writes the `state` column or
`incident_events` rows for lifecycle transitions. The earlier
documented states `ready_to_pr`, `pr_opened`, and `stalled` were never
materialised in the implementation — `running` jumps straight to `complete`
when the orchestrator opens a PR, and budget exhaustion currently
transitions to `failed` (with `runtime_budget_exhausted` /
`human_resume_budget_exhausted` reasons). A follow-up will revisit the
budget path and route it through `awaiting_human` so the human gets the
last word.

### Agent-run orchestration

After each `new` or `regressed` issue:

1. Group the issue into an incident.
2. Create an incident root Slack thread if one does not already exist.
3. Enqueue an agent run only when `autoInvestigateIssuesEnabled = true`.
4. Refuse to start a second active agent run for the same incident.

If more issues join an active incident, append an `incident_context_changed` event, update the Slack thread, and steer the existing managed session instead of creating a parallel run.

Budget defaults:

- 1 active agent run per incident
- 90 minutes cumulative runtime
- 3 human resume cycles
- transition to `failed` (reason `runtime_budget_exhausted` or `human_resume_budget_exhausted`) on budget exhaustion, with a final Slack summary

### Repo discovery

Repository selection is re-run for every agent run. Superlog does not persist a project-level repo mapping.

Flow:

1. Enumerate repos from the org's installed GitHub App installation.
2. Score repos from service-name tokens, normalized frame path tokens, and code-surface hints.
3. Clone only the top 3 candidates read-only into the managed session.
4. Pick the first repo that matches the incident with concrete evidence.
5. If no candidate clears the threshold, pause in Slack and request human input.

### PR and credential boundary

GitHub write credentials do not enter the managed agent.

The managed agent produces:

- selected repo,
- branch metadata,
- validation commands,
- unified diff patch,
- confidence result.

The orchestrator then:

1. re-clones the selected repository in a fresh workspace,
2. reapplies the patch outside the agent,
3. reruns validation commands,
4. pushes `superlog/<incident-id>`,
5. opens the PR through the GitHub App.

No PR is opened unless the confidence gate passes.

### Confidence gate

The gate is rule-based, not model-scored.

A run may move from `running` to `complete` with an opened PR only when it has:

- selected a repo confidently,
- reproduced or otherwise concretely validated the bug,
- produced an applyable patch,
- provided validation commands,
- passed post-fix validation when replayed by the orchestrator.

Otherwise the system either waits for human input or terminates without opening a PR.

### Slack behavior

Each incident gets one root Slack message. Agent-run updates stay in that thread.

Persist all milestones in `incident_events`, but only post milestone summaries to Slack:

- repo selected,
- reproduction result,
- hypothesis change,
- awaiting human,
- resumed,
- gate passed,
- PR opened,
- terminal failure.

While an agent run is `awaiting_human`, any non-bot reply in the Slack thread becomes a `human_reply` event. The worker resumes the same managed session from that event stream.

## Consequences

### Positive

- The product now has a durable incident-level control plane instead of one-shot issue alerts.
- Slack becomes the human handoff and resume channel without forcing operators into the UI.
- Patch replay outside the agent keeps GitHub write credentials out of the runtime and gives Superlog a deterministic last validation pass.
- Provider lock-in stays limited to the runtime adapter rather than the whole orchestration model.

### Negative

- Anthropic is the only supported runtime in the first implementation.
- Repo selection is heuristic and may still require humans in orgs with many similar repositories.
- The first grouping heuristic is conservative and may under-cluster some related regressions.

## Follow-up

- Add an OpenAI-backed runtime adapter behind the same agent-run contract.
- Improve repo scoring with richer code search and historical incident/repo signals.
- Add richer incidents and agent-run UI on top of the new API surface.

## May 2026 update: merge incidents & agent runs

In May 2026 we merged the user-facing distinction between an incident and what
this ADR called an "investigation". The agent-run concept survives as a thinner
execution wrapper, but findings (root cause, severity suggestion, noise/
resolution classification, summary) now live on the incident row — flattened
by the worker on every successful run. The incident's timeline and resolution
are the user-facing surface; agent runs are a section within the incident
view, restartable, with full run history retained for audit.

Schema-level changes:

- `investigations` → `agent_runs`
- `investigation_events` → `incident_events`
- `investigation_id` FK columns → `agent_run_id` on `incident_events`,
  `agent_pull_requests`, `agent_linear_tickets`
- New columns on `incidents`: `agent_summary`, `root_cause_text` +
  `root_cause_confidence`, `estimated_impact_text` +
  `estimated_impact_confidence`, `suggested_severity`,
  `noise_classification` jsonb, `resolution_classification` jsonb,
  `findings_agent_run_id` FK
- Config flags renamed: `investigation_provider` → `agent_run_provider`,
  `investigation_enabled` → `agent_run_enabled`

API change: `/incidents/:id` GET now returns `agentRun`, `agentRuns`,
`timeline` in one round trip. The `/incidents/:id/agent-run` subroute
exists for back-compat but the web no longer needs it.

Webhook change: event name `investigation.completed` → `agent_run.completed`.
See [docs/webhooks.md](../webhooks.md) for the current payload shape.
