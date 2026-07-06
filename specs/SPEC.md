# Superlog Spec

In this document, we'll maintain a description of what Superlog needs to do.


# Issue

Whenever a client sends us a new error trace or error log, we'll fingerprint them into **Issues**.

Repeated occurrences of the same error log or trace count as one **Issue**.

## Issue states

When an **Issue** is created, it starts as `open`. An `open` **Issue** should trigger an **Incident**. 

- An **Issue** can be `silenced`, in which case any new occurrences will not start new **Incidents**.
- An **Issue** can be `under observation`. An **Issue** in `under observation` must have an `escalation trigger`.
    - If an `escalation trigger` fires, the **Issue** becomes `open` again and triggers a new **Incident**. The new Incident has access to previously gathered context. 
    - An `escalation trigger` can be:
        - a rate of errors (errors per minute)
        - an absolute count of events
    - Reoccurences of the Issue `under observation` do not cause anything until the `escalation trigger` trips.
- An **Issue** can be `resolved`. New occurences of the same error will trigger an **Incident**. The investigations of the reoccuring issue will be able to consult previous findings if necessary.


# Incident 

On any new `open` **Issue**, or on new occurrences of a `resolved` **Issue**, Superlog opens a new **Incident**.

An **Incident** starts a new **Agent Run**. During an **Agent Run** an LLM will examine the error, all relevant telemetry, code and infrastructure in order to understand the issue and resolve it. 

## Incident states

- `open`
- `resolved`

## Issue grouping

Issue fingerprinting is, unfortunately, never exhaustive. We must be resilient to duplicate noisy issues. That is why, whenever a new Issue starts a new Incident, we must first compare the Issue to all currently open Incidents. 

If the Issue is not a separate problem, but another manifestation of a root cause of another Incident, we should add this Issue to the Issues of that Incident. 


## Issue is Noise 
The LLM agent can determine that an issue is 'noise'. 

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
- internal users are impacted in a meaningful way

the Superlog agent must attempt to resolve the issue. The resolution is a multi-step process that can involve the following actions:

- Modifying the source code of the observed system and opening Pull Requests 
    - Responding to comments on these PRs to adjust them
    - Waiting for PRs to be merged
    - Merging these PRs if instructed to by the Client (e.g. by a button on the PR message on Slack)
    - Opening subsequent PRs
- Opening Approval prompts 

### Approval prompt

An Approval prompt is a way for our agent to make changes in the client's infrastructure, databases and other systems with the user's approval. When Superlog has access to the customer's infrastructure, for example, their AWS account, Superlog must always send Approval Prompts before taking action. 


### Non-noise Incident states 

An Incident can be `open` (during the execution of the Agent Run).

#### Resolution by the agent

Once the agent has performed all the actions necessary to mitigate the issue at hand, it can set the Incident as `resolved`. For example, when the user merges the PR that the agent has proposed, and it was the only action necessary to resolve the issue, the agent should `resolve` the Incident.

If another PR or action is necessary, the agent should perform these actions and not resolve the Incident.

If the client closes the PR and it is obvious from the context that the issue is actually noise, the agent should `resolve` the Incident and `silence` the related issues or put them `under observation`.

#### Resolution by a human

The users of Superlog can also resolve Incidents by clicking the corresponding button.
If the interface allows so, we should provide two buttons:
- **Problem resolved** -> Incident goes to 'resolved', issues go to 'resolved'
- **Not an issue** -> Incident goes to 'resolved', issues go to 'silenced'

# Memory 

Humans and agents can add notes on various Superlog entities in order to:
- personalize Superlog for clients
- improve investigation quality.

There are two ways to store memory in Superlog: comments and project memory

## Comments
Issues and Incidents have associated Comments. Humans and Agents can add Comments that are visible to the Agent Run investigating the Incident.

## Project memory
Every Project has a list of Memories that can be added by humans and Agents. A Memory is a dated free-form text. All Project memories are visible to the Agent Run investigating the Incident. Agents can add new Memories during investigations and in response to PR comments, Slack messages and other interactions with users.

# Weekly update

Once per week, Superlog must send to the connected Slack channel an update containing a global review of all issues, including the number of issues counted as noise. 


# Changelog

July 6, 2026 - initial commit