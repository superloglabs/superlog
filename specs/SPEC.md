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

Determine the outcome of every issue linked to the Incident. These outcomes are applied atomically when the Agent resolves the Incident; they are not separate actions:

- Silence an issue. If the system is operating normally, and an Issue is a false positive, the Issue must be silenced. It will not raise Incidents anymore.
- Put an issue under observation. If the Issue is a one-off event and needs observation (see above), the Issue needs to be placed under observation with an Escalation trigger.
- Resolve an issue. If the impact of an issue has ceased due to other factors, and no more action can be taken, the issue needs to be Resolved.

Take actions to resolve the root cause of the incident (multiple times, iterating and responding to external triggers). These tools might or might not be available in a given project:

- Modify the source code and open a PR. The agent never holds push credentials: it produces a patch, and the platform applies the patch and opens the PR on its behalf.
- Produce an Approval prompt for an action that is available to it:
    - an infra fix via AWS CLI
    - other tools available to the agent (to be extended)
When a human approves an Approval prompt, the platform executes the approved command verbatim under the customer-owned action role and reports the result back to the agent's session. The agent does not execute approved commands itself.
- Require a prompt for human input and ask for clarification.
- If no action tools are available, the agent can 'complete_investigation'.
- If the root cause is proven to be external and Superlog cannot remediate it, the agent can report the external cause and wait for an external change.

And then, finally,

- Resolve the incident. If the impact on the system has ceased (or there has been no impact), or the action of the agent (PRs, approval prompts) have resolved the root cause of the Incident, the agent can resolve the Incident.
    - As part of resolving the Incident, every connected Issue must be atomically set to `resolved`, `silenced`, or `under observation`.


## Session continuity

Each Incident is investigated by one durable agent session. A terminal-for-turn intervention ends the current turn, but not necessarily the investigation: the session can remain waiting on a PR comment, merge or close, an approval decision, an external change, or a human answer. Any inbound event on the Incident resumes the same session with its context intact. The agent responds on the channel the inbound event arrived on.

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

### General principles

The prompt of the agent must be short and clear. The goal and the workflow of the agent must be explicit.

The outcomes of the agent must be provided as tools that the agent can call based on its investigation.

### Turn
A unit of agent action is a turn. A successfully executed terminal tool ends a turn and determines whether the Incident is resolved, the investigation is completed, or the session waits for external input. A rejected tool call does not end the turn; the agent receives the error and can correct the call.

This section describes the desired agent contract. The implementation may temporarily lag behind it while the contract is rolled out.

## Available tools

### General tools

1. **`report_findings`** (non-terminal) — shared metadata, callable repeatedly.

Records shared metadata before an outcome. Callable repeatedly; fields are last-write-wins. `propose_pr`, `complete_investigation`, `report_external_cause`, and `resolve_incident` refuse to run until it has been called. `ask_human` may be called without findings when the missing human input is what prevents the investigation.

- `summary` (required) — 1-2 sentences, operator's view, symptom before mechanism
- `proposedTitle` — replacement incident title, symptom-first, never the fix
- `rootCause` + `rootCauseConfidence` (0-10) — markdown RCA; every claim backed by verbatim quotes
- `estimatedImpact` + `impactConfidence` (0-10)
- `severity` — SEV-1 / SEV-2 / SEV-3
- `handoffNotes` — for a future follow-up run: files examined, ruled-out hypotheses, repo gotchas


### Terminal tools

#### 2. `propose_pr`

Opens or updates one or more PRs and then ends the turn while the session waits for PR lifecycle events. A single call can cover a change spanning multiple repositories, with at most one PR per repository. Each PR has its own unified diff under `/mnt/session/outputs/`; patches are never embedded in the tool call. Any PR comment, merge, or close starts another turn, in which the agent can update a PR and wait again.

Input:

- `pullRequests` (required, non-empty array), where every entry contains:
    - `repoFullName` (required string) — repository in `owner/repo` form; unique within the call.
    - `title` (required string)
    - `body` (required string)
    - `branchName` (required string) — must start with `superlog/`.
    - `baseBranch` (required string)
    - `patchFilePath` (required string) — a distinct unified-diff file under `/mnt/session/outputs/` containing changes only for this repository.
    - `changedFiles` (optional string array)
    - mobile-regression fields (optional, according to the connected mobile-test integration)

A new `branchName` opens a PR. Reusing the same repository and `branchName` pushes the patch as a follow-up commit to that PR. The agent must validate every patch before calling the tool. The platform validates all entries and patch applicability before opening any PR. If an external operation nevertheless partially fails, the tool returns a result for every entry, keeps the turn active, and the agent retries only the failed entries. The turn ends only when every PR requested by the call has been recorded successfully.

This tool is only for defects with real user or business impact. Noise is classified when resolving the Incident and must not be patched merely to quiet its signal.

#### 3. `complete_investigation`

Available only when PR creation is disabled or unavailable and no approval-prompt action is available. It finishes a findings-only investigation while leaving the Incident open. When Linear is connected, it triggers the Linear handoff. Requires `report_findings`; does not classify issues. No params.

#### 4. `ask_human`

A human must act or answer first; the turn ends and the run pauses with its session intact until a reply arrives. Param: `question`. Covers missing context, a code artifact absent from every mounted repository, a decision between remediation paths, or a failing code path the agent could not locate. The agent states what it found and asks the concrete question that unblocks action.

#### 5. `report_external_cause`

Reports that the root cause is outside the systems Superlog can remediate. It ends the turn and leaves both the Incident and its Issues open while the session waits for an external change or a human update. Use it only when the external cause is established and there is no concrete unanswered question; use `ask_human` when an answer or decision is needed.

Input:

- `cause` (required string) — concise explanation of the external root cause.
- `source` (required string) — the external provider, service, customer-owned system, or other responsible system.
- `evidence` (required string) — evidence establishing that the cause is external and explaining how it produces the observed impact.
- `recommendedNextStep` (required string) — the action an operator or external owner should take, or the condition Superlog should wait for.

Requires `report_findings`. This tool does not classify issues or resolve the Incident.

#### 6. `resolve_incident`

The global resolution of the Incident. Use it once everything required has been done and the impact has ceased, or when the investigation proves that no remediation is needed and the relevant Issues should be silenced or observed. This tool is terminal for both the turn and the Incident.

Input:

- `reason` (required string) — why no further action is required.
- `evidence` (required string) — evidence that the impact has ceased or that no meaningful impact existed, including a before/after signal and window when telemetry is the proof.
- `issueOutcomes` (required array) — exactly one entry for every Issue linked to the Incident. Every entry contains:
    - `issueId` (required string) — unique within the array.
    - `status` (required enum) — `resolved`, `silenced`, or `under_observation`.
    - `reason` (required string) — why this is the correct outcome for the Issue.
    - `evidence` (required string) — evidence supporting the outcome.
    - `escalateOn` (conditionally required enum) — `events_per_minute` or `additional_events`; required only for `under_observation`.
    - `threshold` (conditionally required integer, minimum 1) — required only for `under_observation`.

Only error Issues can be `silenced` or placed `under_observation`; alert-episode Issues must be `resolved`. Observation fields are forbidden for other statuses. The platform validates the complete set—including missing or duplicate Issue IDs and status/type compatibility—before changing state. Issue classification and Incident resolution are one atomic operation: if any entry is invalid, neither the Issues nor the Incident are changed, and the turn remains active so the agent can correct the call.

Requires `report_findings`.

### Approval prompts (in progress)

The Approval-prompt outcome for infrastructure, database, and other customer-authorized changes is still in development. When built, it will join this contract as a terminal-for-turn action that waits for approval and execution results before resuming the same session.


### PR lifecycle events

When an agent PR receives a comment, is merged, or is closed, the platform resumes the Incident's session with the event context. The agent decides what follows: update one or more PRs, open cross-repository follow-up PRs, report an external cause, ask a human, or resolve the Incident with all Issue outcomes. Merge only auto-resolves the Incident as a fallback when no session can be resumed (e.g. expired), so Incidents never stay open forever.

### Contract mechanics

- Tool schemas are flat (`type`/`properties`/`required` only) — runner APIs reject top-level composition keywords at agent-create time.
- Runner APIs don't enforce custom-tool schemas server-side, so the worker re-validates every call and error-acks invalid input with a model-readable message; the model corrects the call within the same session. Identical-tool error acks are capped per turn, then the budget backstops own the runaway session.
- Legacy sessions may know retired tools such as `report_failure`, `mark_already_resolved`, `silence_as_noise`, `place_under_observation`, or `resolve_issue`. During rollout, the validator must continue recognizing them and return a model-readable error directing the agent to the current terminal outcomes rather than hard-failing the run as an unknown tool.

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
July 14, 2026 - desired agent contract: terminal batched PR proposals (one PR and patch per repository), atomic per-Issue outcomes inside resolve_incident, report_external_cause waiting with the Incident open, and Approval prompts documented as in progress
