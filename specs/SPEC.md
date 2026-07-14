# Superlog Spec

In this document, we'll maintain a description of what Superlog needs to do.


# Issue

An **Issue** is the unit that triggers an **Incident**. There are two kinds of **Issues**:

- **Errors**: error logs and error traces. Whenever a client sends us a new error trace or error log, we fingerprint it into an **Issue**. Repeated occurrences of the same error log or trace count as one **Issue**.
- **Alert episodes**: one contiguous breach period of an **Alert** — from the evaluation tick where the alert starts firing to the tick where it recovers. Every new breach is a new **Issue**. An alert episode records the breach window (start and end times) and the observed values (at open, at peak, and latest), and the **Issue** carries the alert's configuration (what is measured, the filter, aggregation, comparator, threshold, and evaluation window).

## Issue kinds

There are two kinds of error issues, and one kind of alert issues.

### Errors

There are two types of error Issues:
1. Error logs (i.e. log lines with a severity of level attribute indicating it's an error log).
2. Error spans (i.e. log spans with a status attribute indicating it's an error span).

### Alert episodes

Any alert breach period (called an Episode) is an Issue.

## Issue states

When an **Issue** is created, it starts as `open`. An `open` **Issue** should trigger an **Incident**. 

The `silenced` and `under observation` states below apply to error **Issues** only. An alert-episode **Issue** is only ever `open` or `resolved`: if an alert fires for a real problem, resolve the **Incident** when the problem is gone or fix the underlying cause; if an alert is noisy, the remedy is to tune its threshold or disable the alert, not to silence its episodes.

- An **Issue** can be `silenced`, in which case any new occurrences will not start new **Incidents**.
    - Only an Error Issue (an error log or an error span) can be silenced.
- An error **Issue** can be `under observation`. An **Issue** in `under observation` must have an `escalation trigger`.
    - If an `escalation trigger` fires, the **Issue** becomes `open` again and triggers a new **Incident**. The new Incident has access to previously gathered context. 
    - An `escalation trigger` can be:
        - a rate of errors (errors per minute)
        - an absolute count of events
    - Occurrences of the Issue `under observation` do not cause anything until the `escalation trigger` trips.
    - Only an Error Issue (an error log or an error span) can be under observation.
- An **Issue** can be `resolved`. New occurrences of the same error will trigger an **Incident**. The investigations of the recurring issue will be able to consult previous findings if necessary.


# Incident 

On any new `open` **Issue**, or on new occurrences of a `resolved` **Issue**, Superlog opens a new **Incident**.

For alert episodes, "recurrence" means a new breach of the same alert: the new episode joins the alert's currently open **Incident** if one exists; otherwise it opens a new **Incident** chained to the previous one, with access to its findings.

An **Incident** starts a new **Agent Run**. During an **Agent Run** an LLM will examine the error, all relevant telemetry, code and infrastructure in order to understand the issue and resolve it. 

## Incident states

- `open`
- `resolved`

## Issue grouping

Issue fingerprinting is, unfortunately, never exhaustive. We must be resilient to duplicate noisy issues. That is why, whenever a new Issue starts a new Incident, we must first compare the Issue to all currently open Incidents. 

If the Issue is not a separate problem, but another manifestation of a root cause of another Incident, we should add this Issue to the Issues of that Incident. 

Alert episodes participate in grouping like errors do: multiple episodes can be grouped into one Incident, and an alert episode can join an Incident opened by errors (or vice versa) when they share a root cause — for example, a latency alert and the error causing it.


## Issue is Noise 
The LLM agent can determine that an issue is 'noise'. Noise classification (`silenced` / `under observation`) applies to error issues only; if an alert-episode Incident turns out to need no action, the Incident is resolved and the alert itself should be tuned or disabled.

An issue counts as 'noise' if the system is behaving normally, no users are impacted, or users are not impacted in a meaningful way.

For example, if a user is trying to access a page of a landing website that does not exist, and the system logs an error log, it is noise rather than a real issue.


### Noise states

### Intended behaviour / no impact

If the issue indicates intended behaviour and there is no impact on users whatsoever, the agent must set the issue to `silenced`. The incident is then `resolved`. 

### 'One-off' errors: Observation

If the issue indicates a one-off non-critical event, the agent must set the issue to `under observation` and specify an `escalation trigger` after which we'll need to re-evaluate this issue.

For example, if a user was soft-deleted by manual admin action and residual non-authorized calls of that user remain in logs, the user is slightly impacted, but the system is still behaving as intended. Superlog must place the issue under observation. If, subsequently, actions of all users are rejected as unauthorized due to a database error, the `escalation trigger` will cause Superlog to investigate that ocurrence separately. 


### Counterexample: silencing errors in code

Often, codebases contain many false-positive errors: error logs on 404s, unauthorized requests after JWT expiration. If Superlog starts to open pull requests to move all these logs to WARN, catch them or stop logging them, teams will quickly be overwhelmed. We must instead silence these errors.

## Issue is Not Noise

If the issue is not noise, that is to say:

- end users are impacted in any way
- performance is significantly degraded
- a system that used to be running is inoperative without reason
- internal users are impacted in a meaningful way,

the Superlog agent must attempt to resolve the issue.

The resolution is a multi-step process that can involve the following actions:

- Modifying the source code of the observed system and opening Pull Requests 
    - Responding to comments on these PRs to adjust them
    - Waiting for PRs to be merged
    - Merging these PRs if instructed to by the Client (e.g. by a button on the PR message on Slack)
    - Opening subsequent PRs
- Opening Approval prompts 

Opening PRs and Approval prompts continues in a loop until the issue is Resolved.

Both the source code modification and approval prompts can be disabled in the settings. If no resolution tools are available, the agent must submit its findings.

### Approval prompt

An Approval prompt is a way for our agent to make changes in the client's infrastructure, databases and other systems with the user's approval. When Superlog has access to the customer's infrastructure, for example, their AWS account, Superlog must always send Approval Prompts before taking action. 


#### Resolution by the agent

Once the agent has performed all the actions necessary to mitigate the issue at hand, it can set the Incident as `resolved`. For example, when the user merges the PR that the agent has proposed, and it was the only action necessary to resolve the issue, the agent should `resolve` the Incident.

If another PR or action is necessary, the agent should perform these actions and not resolve the Incident.

If the client closes the PR and it is obvious from the context that the issue is actually noise, the agent should `resolve` the Incident and `silence` the related issues or put them `under observation`.

#### Resolution by a human

The users of Superlog can also resolve Incidents by clicking the corresponding button.
If the interface allows so, we should provide two buttons:
- **Problem resolved** -> Incident goes to 'resolved', issues go to 'resolved'
- **Not an issue** -> Incident goes to 'resolved', issues go to 'silenced'

# Agent

The following describes how a Superlog agent should work — how it accomplishes an Agent Run.

## Goal of the agent

An agent needs to accomplish an Agent Run described above.

An Agent Run starts with a new Incident being opened from either a new Issue (an error or an alert episode — see Issue kinds above), a recurrence of a `resolved` Issue, or a trip of an Escalation trigger.

## Agent actions

During an Agent Run, the Agent can:

Manage issues:

- Silence an issue. If the system is operating normally, and an Issue is a false positive, the Issue must be silenced. It will not raise Incidents anymore.
- Put an issue under observation. If the Issue is a one-off event and needs observation (see above), the Issues needs to be placed under observation with an Escalation trigger.
- Resolve an issue. If the impact of an issue has ceased due to other factors, and no more action can be taken, the issue needs to be Resolved. 

Take actions to resolve the root cause of the incident (multiple times, iterating and responding to external triggers). These tools might or might not be available in a given project:

- Modify the source code and open a PR. The agent never holds push credentials: it produces a patch, and the platform applies the patch and opens the PR on its behalf.
- Produce an Approval prompt for an action that is available to it:
    - an infra fix via AWS CLI
    - other tools available to the agent (to be extended)
When a human approves an Approval prompt, the platform executes the approved command verbatim under the customer-owned action role and reports the result back to the agent's session. The agent does not execute approved commands itself.
- Require a prompt for human input and ask for clarification.
- If no action tools are available, the agent can 'complete_investigation'.

And then, finally,

- Resolve the incident. If the impact on the system has ceased (or there has been no impact), or the action of the agent (PRs, approval prompts) have resolved the root cause of the Incident, the agent can resolve the Incident.
    - All issues connected to the Incident must be either resolved, silenced or put under observation prior to resolving the incident.


## Session continuity

Each Incident is investigated by one durable agent session. Intervention outcomes do not end the investigation — they leave the session waiting on an external event: a PR comment, a PR merge or close, an approval decision, or a human answer to a clarification. Any inbound event on the Incident resumes the same session with its context intact. The agent responds on the channel the inbound event arrived on.

## Inputs of the agent

### Issues
The agent must have full access to the triggering issue as part of its prompt.

- For an error Issue: the error sample (log/trace), stack frames, and trace context.
- For an alert-episode Issue: the alert's configuration (source/metric, filter, aggregation, comparator, threshold, evaluation window, grouping) and the episode itself (breach start time, end time if recovered, and the observed values at open, peak, and latest). No synthetic error-shaped sample is shown for alerts.

If the Incident was opened by a recurrence of a `resolved` Issue or by an Escalation trigger, the findings of the predecessor Incident(s) must be part of the prompt as well.

### Memory
Comments on the related Issues, and all Project Memories (see Memory above), must be visible to the agent. The agent must have a tool to add new Memories during the investigation.

### Telemetry
The agent must have free access to all the telemetry of the related project, but not as part of its prompt and rather as an MCP / tool.

### Source code
The agent must have access to the Github repositories that this project has access to. The agent should either have the repositories cloned already, or a tool to clone relevant repositories based on its investigations.

### Infrastructure
When the customer has connected their infrastructure (e.g. an AWS account), the agent must have read-only access to it as a tool. Any change to infrastructure goes through an Approval prompt.

## Structure of the agent

The prompt of the agent must be short and clear. The goal and the workflow of the agent must be explicit.

The outcomes of the agent must be provided as tools that the agent can call based on its investigation.

## Outcome tools

The tool contract (source of truth: `apps/worker/src/agent-outcome-tools.ts`) has three tiers:

1. **`report_findings`** (non-terminal) — shared metadata, callable repeatedly.
2. **Action tools** (non-terminal, executed server-side mid-run): `propose_pr`, `silence_as_noise`, `place_under_observation`, `resolve_issue`. The platform executes each call while the session is live and returns the result to the agent — a PR call returns the PR URL (or the apply failure, which the agent can fix and retry); a classification call applies to the issue immediately.
3. **Terminal tools**: `resolve_incident` ends the investigation and resolves the incident; `complete_investigation` ends the investigation while leaving the incident open, and is only exposed when no PR or approval-prompt action is actually available; `ask_human` pauses it on a human.

A turn may also legitimately end with **no** terminal call when the agent is waiting on external events — open PRs out for review. If Linear is connected, the platform creates this run's ticket as soon as the first PR is successfully recorded. It then cross-links every PR independently: the PR gets the ticket link and the ticket gets the PR link. Later PRs reuse the same run-scoped ticket, and the Slack PR/waiting updates include it. The run then parks (`awaiting_events`) with its session intact and is resumed by a PR comment, merge, or close (or any human message). Ending a turn with no terminal call *and* nothing pending gets one nudge, then the budget backstops fail the run: a diagnosis that ends with nothing happening is not an outcome.

### report_findings (non-terminal)

Records shared metadata before any acting tool. Callable repeatedly; fields are last-write-wins. All action tools, `complete_investigation`, and `resolve_incident` refuse to run until it has been called.

- `summary` (required) — 1-2 sentences, operator's view, symptom before mechanism
- `proposedTitle` — replacement incident title, symptom-first, never the fix
- `rootCause` + `rootCauseConfidence` (0-10) — markdown RCA; every claim backed by verbatim quotes
- `estimatedImpact` + `impactConfidence` (0-10)
- `severity` — SEV-1 / SEV-2 / SEV-3
- `handoffNotes` — for a future follow-up run: files examined, ruled-out hypotheses, repo gotchas

### Action tools (non-terminal)

**`propose_pr`** — intervention: a validated patch for a defect with real user/business impact. The agent writes a unified diff to a distinct file under `/mnt/session/outputs/`; the platform applies it and opens the PR mid-run, returning the URL or the failure (the agent never holds push credentials). PRs are keyed by branch: a **new** `branchName` opens an independent PR; the **same** `branchName` pushes the patch as a follow-up commit on that PR (how review feedback is addressed). Params: `repoFullName`, `title`, `body`, `branchName` (must start `superlog/`), `baseBranch`, `patchFilePath`; optional `changedFiles`, mobile-regression fields. The agent validates its own patch before proposing; noise is classified, never patched — no PRs that only quiet a signal.

**`silence_as_noise`** — one issue is proven a false positive; it is silenced permanently, so the evidentiary bar is high (quote the success path / contract clause). Params: `issueId`, `reason` (full-text), `evidence`.

**`place_under_observation`** — one issue is plausibly noise but unproven; it goes quiet until the escalation trigger trips. Params: `issueId`, `reason` (full-text), `evidence`, `escalateOn` (`events_per_minute` | `additional_events`), `threshold` (int ≥ 1).

**`resolve_issue`** — one issue's impact has ceased (already fixed, transient cleared, upstream recovered, or fixed by the agent's own merged PR). Params: `issueId`, `reason` (full-text), `evidence` (before/after signal + window).

Only error issues can be silenced or observed; alert-episode issues can only be resolved.

### Terminal tools

**`resolve_incident`** — the global resolution of the incident: impact has ceased (or never was), or the agent's actions resolved the root cause. Rejected (with the list) while any linked issue is still unclassified. Params: `reason` (full-text), `evidence` (before/after signal + window).

**`complete_investigation`** — finish a findings-only investigation, create the external ticket handoff when Linear is connected, and leave the incident open. It is available only when PR creation is disabled or unavailable and no approval-prompt action is available. Requires `report_findings`; does not require issue classification. No params.

**`ask_human`** — a human must act or answer first; the run pauses and resumes with session intact on reply (waiting indefinitely is by design). Param: `question`. Covers: missing context; a code artifact absent from every mounted repo; a diagnosis whose remediation is not the agent's to make (third-party defect, provider quota, customer-owned config, a decision between fix paths); a failing code path the agent could not locate. In each case the agent states what it found and asks the concrete question that unblocks action.

The Approval-prompt outcome (infra fix via AWS CLI etc.) is not yet a tool; when built it joins this contract as an action-or-waiting tool.

### PR lifecycle events

When an agent PR is merged or closed, the platform resumes the incident's session with the event context and the agent decides what follows — resolve the incident, push more commits, open another PR, or classify remaining issues. Merge only auto-resolves the incident as a fallback when no session can be resumed (e.g. expired), so incidents never stay open forever.

### Contract mechanics

- Tool schemas are flat (`type`/`properties`/`required` only) — runner APIs reject top-level composition keywords at agent-create time.
- Runner APIs don't enforce custom-tool schemas server-side, so the worker re-validates every call and error-acks invalid input with a model-readable message; the model corrects the call within the same session. Identical-tool error acks are capped per turn, then the budget backstops own the runaway session.
- Retired tools (`report_failure` — removed 2026-07-08 because it let a run end without findings; `mark_already_resolved` — replaced 2026-07-10 by the per-issue `resolve_issue` + `resolve_incident`) are still recognized by the validator: old sessions that resume and call one get an error ack redirecting to the live outcomes, not an unknown-tool hard failure.

# Memory

Humans and agents can add notes on various Superlog entities in order to:
- personalize Superlog for clients
- improve investigation quality.

There are two ways to store memory in Superlog: comments and project memory

## Comments
Issues have associated Comments. Humans and Agents can add Comments that are visible to the Agent Run investigating the Incident.

## Project memory
Every Project has a list of Memories that can be added by humans and Agents. A Memory is a dated free-form text. All Project memories are visible to the Agent Run investigating the Incident. Agents can add new Memories during investigations and in response to PR comments, Slack messages and other interactions with users.

# Weekly update

Once per week, Superlog must send to the connected Slack channel an update containing a global review of all issues, including the number of issues counted as noise.


# Changelog

July 6, 2026 - initial commit
July 9, 2026 - Issues are either errors or alert episodes. An alert-episode Issue is one breach period (new breach = new Issue), only uses `open`/`resolved`, and groups into Incidents like errors do.
July 9, 2026 - merged the managed-agent spec into this document
July 10, 2026 - agent loop rework: full-text reasons, non-terminal propose_pr (multiple PRs, keyed by branch), per-issue classification tools, terminal resolve_incident, awaiting_events parking, PR merge/close resumes the session
July 14, 2026 - deterministic Linear handoff: when Linear is connected, each explicitly completed investigation gets its own ticket, while PR-producing runs create/reuse their run-scoped ticket on the first recorded PR and cross-link every later PR; resolve-time filing is configurable; completed Linear tickets resolve incidents and count as accepted remediation. Projects without PR or approval actions finish through complete_investigation.
