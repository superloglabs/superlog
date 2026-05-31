# Loops Welcome Flow

Superlog upserts a server-side Loops contact whenever setup state changes. Loops is a messaging
mirror; Postgres remains the source of truth.

## Setup

Create a Loops workflow with:

- Trigger: Event received
- Event name: `superlogWelcome`
- API env: `LOOPS_API_KEY`
- Optional override: `LOOPS_WELCOME_EVENT_NAME`

Superlog uses `PUT /contacts/update`, so contacts are created on signup and updated if they were
created manually in Loops first.

Contact properties:

- `email`
- `userId`
- `orgId`
- `orgName`
- `orgSlug`
- `projectId`
- `projectName`
- `projectSlug`
- `signupSource`
- `appUrl`
- `telemetrySet`
- `telemetrySetAt`
- `githubAdded`
- `githubAddedAt`
- `slackAdded`
- `slackAddedAt`
- `mcpInstalled`
- `mcpInstalledAt`

Sync points:

- Signup and every `GET /api/me`
- CLI/skill activation approval
- GitHub OAuth completion
- Slack OAuth completion
- MCP OAuth token issuance
- Ingest proxy auth after an API key is used

The welcome event payload includes the same org/project/signup context under `eventProperties`.

## Flow Copy

### Email 1 - Immediate

Subject: Welcome to Superlog

Preview: The fastest path is one agent prompt, one deploy, then your first useful incident.

Body:

Hi,

Welcome to Superlog. The goal is simple: get traces, logs, and metrics flowing, then let Superlog
turn noisy failures into the issue, evidence, and fix path your team needs.

Start with your first project: {{ eventProperties.projectName }}.

Open Superlog: {{ eventProperties.appUrl }}

Paste the install prompt from onboarding into your coding agent, merge the generated PR, and deploy
as usual. Once the first event arrives, the dashboard will switch from setup to live signal.

Thanks for trying it,
Ash

### Email 2 - 24 Hours Later

Subject: Did Superlog catch the first event?

Preview: A quick check to make sure setup made it from PR to live telemetry.

Body:

Hi,

Quick setup check for {{ eventProperties.orgName }}.

If events are flowing, open the Issues page and look for grouped failures with trace and log
evidence attached. If nothing has arrived yet, the usual culprit is an ingest key or deploy env var
that did not make it into the runtime.

Open Superlog: {{ eventProperties.appUrl }}

You do not need perfect instrumentation on day one. One real request path is enough to prove the
loop.

### Email 3 - 3 Days Later

Subject: Let Superlog work the next failure

Preview: Once telemetry is live, connect the workflow that turns incidents into fixes.

Body:

Hi,

Once Superlog sees production signal, the next useful step is connecting the workflow around it:
GitHub for fix PRs, Slack for incident updates, and alerts for the failures worth interrupting
someone over.

Open Superlog: {{ eventProperties.appUrl }}

The product is best when it is allowed to follow the thread from telemetry to evidence to a proposed
change. That is the loop worth setting up first.
