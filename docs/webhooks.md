# Webhooks

Superlog sends webhooks to your server when something happens to an incident in
a project. They're designed as **messages to relay** to an outgoing integration
— Telegram, email, SMS, a status page, PagerDuty, your data warehouse, or any
internal tooling — so every payload carries both render-ready text and the full
structured state.

## The model: two events

There are exactly two events, and they map directly onto how a messaging
integration thinks:

| Event              | Fires when                                                          | Relay it as                          |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------ |
| `incident.created` | A new incident is opened.                                           | A **new message** / a new thread.    |
| `incident.updated` | Anything else happens on that incident (see `change.kind`).         | A **reply** in that thread (or edit).|

Everything that used to be its own event — resolve, reopen, merge, an
investigation starting / finishing / failing / asking for input — is now an
`incident.updated` distinguished by a `change.kind` field. The incident is the
"thread"; an agent run (investigation) is just activity on it.

`change.kind` is one of:

| `change.kind`          | Meaning                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `resolved`             | The incident closed — manual resolve, PR merged, agent classified already-fixed, autorecovery confirmed, or auto-closed as noise. Adds `change.resolution`. |
| `reopened`             | A resolved/noise-closed incident reopened. Adds `change.reason` (`issue_regressed` \| `manual`) and `change.previousStatus`. |
| `merged`               | The incident was a duplicate and merged into a survivor. Adds `change.mergedInto` and `change.evidence`. |
| `agent_started`        | An investigation started. Adds `agentRun`.                                                       |
| `agent_completed`      | An investigation finished with findings — a PR was opened or it reached a no-PR conclusion. Adds `agentRun`, `events`, `pullRequests`, `linearTickets`. |
| `agent_failed`         | An investigation failed. Adds `agentRun` (with `failureReason` / `failureCategory`).             |
| `agent_awaiting_input` | An investigation paused for a human (repo pick, or GitHub not connected). Adds `agentRun` and `change.reason` / `change.summary` / `change.question`. |

Each endpoint chooses whether it gets `incident.created`, `incident.updated`, or
both (both by default). If you only want to do the simplest thing, subscribe to
both and forward `message.title` / `message.body` (see below) verbatim.

## Configuring an endpoint

Go to **Settings → Webhooks** for the project that should send events.

1. Paste your endpoint URL (`https://...`).
2. Tick the **events** this endpoint should receive (both selected by default).
3. Click **Add endpoint**. Superlog generates a signing secret prefixed
   `whsec_` and shows it to you once. Copy it — we never display it again.
4. Use **Send test** to fire a stub payload right away. The delivery shows up in
   the live log under the endpoint.

Expand an endpoint to change its subscribed events later. You can rotate the
secret at any time, disable an endpoint (deliveries are suspended but state is
preserved), or delete it (deletes all delivery history).

## Delivery semantics

- Each event is sent as `POST` with `Content-Type: application/json`.
- Request timeout is **10 seconds**. Anything slower is treated as a failure
  and retried.
- Non-2xx responses and connection errors / timeouts are retried with backoff
  before attempts 2-8: **30s → 1m → 2m → 5m → 15m → 1h → 6h** (no wait before
  attempt 1). After 8 failed attempts (~8h elapsed) the delivery is marked
  `failed` and we stop trying.
- Automatic retries reuse the same `Superlog-Delivery` id — use it as your
  idempotency key. A manual **redeliver** from Settings enqueues a *new*
  delivery row with a *new* id; if you redeliver something we already
  delivered, your receiver will see it twice.
- Disabling an endpoint stops new deliveries from being enqueued, and any
  deliveries still pending at the time the endpoint is disabled are marked
  `failed` with `lastError = "endpoint disabled"` on the next worker tick.
- Deliveries appear under the endpoint in Settings with status, last HTTP code,
  response body (truncated to 2 KiB), next attempt, and any error.
- The **Send test** button posts a stub payload of the form
  `{ event, eventId, occurredAt, test: true, message: { title, body }, project }`
  — it shares transport, signature, and retry behavior with real events but does
  not include `incident`, `change`, `agentRun`, `events`, `pullRequests`, or
  `linearTickets`. Use it to verify transport and signature only.

## Signing

Every request has a `Superlog-Signature` header in Stripe-style format:

```
Superlog-Signature: t=1715450000,v1=<hex>
```

`<hex>` is `HMAC_SHA256(secret, "<t>.<rawRequestBody>")`.

Verify in your handler:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, header: string, rawBody: string): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const ts = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(ts) || !v1) return false;
  // Reject anything older than 5 minutes to block replay attacks.
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Important: verify against the **raw body**, before JSON-parsing. Frameworks
that re-stringify JSON will produce a different hash.

## Headers

| Header                  | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| `Superlog-Signature`    | `t=<unix-ts>,v1=<hex>` HMAC-SHA256 over `<ts>.<body>`  |
| `Superlog-Event`        | `incident.created` or `incident.updated`               |
| `Superlog-Delivery`     | UUID of this delivery — stable across retries          |
| `User-Agent`            | `Superlog-Webhooks/1.0`                                |

## Common envelope

Both events share the same top-level shape:

```json
{
  "event": "incident.created",                  // the event type (matches Superlog-Event)
  "eventId": "5f0a6b6e-...",                    // UUID, unique per event (de-dupe key)
  "occurredAt": "2026-05-11T12:34:56.000Z",     // when we built the payload (ISO-8601)
  "project": { "id": "uuid", "name": "Default", "slug": "default" },
  "message": {                                   // render-ready text — forward verbatim if you like
    "title": "TypeError in /api/orders",
    "body": "New incident (SEV-2 · orders · production)."
  },
  "incident": { ... }                            // see "The incident object" below
}
```

`incident.updated` additionally carries a `change` object (always), and — for
agent-related changes — an `agentRun` object (and, on `agent_completed`, the
`events` / `pullRequests` / `linearTickets` arrays). Unknown top-level keys may
be added over time — treat them as additive.

### The `message` object

The single most useful field for a relay: a pre-rendered, channel-neutral
`{ title, body }` you can forward to Telegram/email/SMS without understanding the
rest of the schema. `title` is the incident title (the "thread subject"); `body`
is a one-line description of what just happened (e.g. `"Resolved: looks fine
now"`, `"Investigation complete: <summary>. Opened PR: <url>"`,
`"Reopened — the underlying issue regressed."`). For anything richer, read the
structured fields below.

### The `incident` object

Present on every event. A curated projection of the incident (Slack anchors,
billing cooldowns and other operational columns are intentionally omitted):

```json
{
  "id": "uuid",
  "title": "TypeError in /api/orders",
  "codename": "squishy-narwhal",
  "status": "open",                              // "open" | "resolved" | "autoresolved_noise" | "merged"
  "severity": "SEV-2",                           // "SEV-1" | "SEV-2" | "SEV-3" | null
  "suggestedSeverity": "SEV-2",
  "service": "orders",
  "environment": "production",                   // nullable
  "firstSeen": "2026-05-11T11:00:00.000Z",
  "lastSeen": "2026-05-11T12:30:00.000Z",
  "issueCount": 14,
  "agentSummary": null,
  "rootCauseText": null,                         // flattened from the latest successful run
  "rootCauseConfidence": null,                   // 0-10
  "estimatedImpactText": null,
  "estimatedImpactConfidence": null,             // 0-10
  "noiseClassification": null,
  "resolutionClassification": null,
  "findingsAgentRunId": null,
  "resolvedAt": null,
  "resolvedByKind": null,                        // e.g. "slack_manual" | "agent_pr_merged" | "agent_classification" | "autorecovery_confirmed"
  "resolvedReasonCode": null,
  "resolvedReasonText": null,
  "mergedIntoId": null,
  "mergedAt": null
}
```

### The `agentRun` object

Present on `incident.updated` when `change.kind` is one of the `agent_*` kinds:

```json
{
  "id": "uuid",
  "state": "running",                            // queued | running | awaiting_human | blocked_no_github | complete | failed | ...
  "runtime": "anthropic",
  "trigger": "incident",                         // incident | pr_comment | feedback | slack_reply | issue_joined
  "startedAt": "2026-05-11T12:20:00.000Z",
  "completedAt": null,
  "cumulativeRuntimeMinutes": 3,
  "resumeCount": 0,
  "failureReason": null,                         // set when change.kind = "agent_failed"
  "failureCategory": null,                       // "agent" | "deliverable" | "infra" (derived from failureReason)
  "selectedRepoFullName": null,
  "selectedBaseBranch": null,
  "result": null                                 // the agent's AgentRunResult (rich on agent_completed)
}
```

## `incident.created`

Just the common envelope — `{ event, eventId, occurredAt, project, message,
incident }` with `incident.status = "open"`. Relay it as a new message / open a
new thread keyed on `incident.id`.

## `incident.updated`

The common envelope plus a `change` object. `change.kind` tells you what
happened; switch on it to decide how to render the reply. Some kinds add fields
to `change`; agent kinds add an `agentRun` (and `agent_completed` adds the
`events` / `pullRequests` / `linearTickets` arrays).

### `change.kind = "resolved"`

Fires for every path that closes an incident, including auto-close as noise.

```json
{
  "change": {
    "kind": "resolved",
    "resolution": {
      "kind": "slack_manual",                    // resolvedByKind; null for the noise path
      "reasonCode": "manual",
      "reasonText": "looks fine now",
      "resolvedAt": "2026-05-11T13:00:00.000Z",
      "status": "resolved"                       // "resolved" | "autoresolved_noise"
    }
  }
}
```

Use `change.resolution.status` to tell a real resolve (`"resolved"`) from a noise
auto-close (`"autoresolved_noise"`); the noise path leaves `kind` null.

### `change.kind = "reopened"`

```json
{
  "change": {
    "kind": "reopened",
    "reason": "issue_regressed",                 // "issue_regressed" | "manual"
    "previousStatus": "resolved"                 // status before reopen, may be null
  }
}
```

### `change.kind = "merged"`

The `incident` is the source (now `status: "merged"`); `change.mergedInto` is the
survivor it folded into.

```json
{
  "change": {
    "kind": "merged",
    "mergedInto": {
      "id": "uuid",
      "codename": "brave-otter",
      "title": "Other incident title",
      "status": "open"
    },
    "evidence": "Same stack frame and root cause as the survivor."
  }
}
```

### `change.kind = "agent_started"`

`change` is just `{ "kind": "agent_started" }`; the payload adds `agentRun`
(state `running`, `result: null`).

### `change.kind = "agent_failed"`

`change` is just `{ "kind": "agent_failed" }`; the payload adds `agentRun` with
`state: "failed"`, `failureReason` set, and `failureCategory` derived from it.

### `change.kind = "agent_awaiting_input"`

```json
{
  "change": {
    "kind": "agent_awaiting_input",
    "reason": "repository_selection",            // "repository_selection" | "no_github_install" | "no_accessible_repos"
    "summary": "I need to know which repo to investigate.",
    "question": "orders or web?"                  // may be null (e.g. GitHub-blocked)
  }
}
```

### `change.kind = "agent_completed"`

The richest update — see the next section.

## `agent_completed` payload (full example)

When `change.kind = "agent_completed"`, the `incident.updated` payload — in
addition to `agentRun` — embeds the run's chronological `events`, opened
`pullRequests`, and filed `linearTickets`.

```json
{
  "event": "incident.updated",
  "eventId": "5f0a6b6e-...",
  "occurredAt": "2026-05-11T12:34:56.000Z",
  "project": { "id": "uuid", "name": "Default", "slug": "default" },
  "message": {
    "title": "TypeError in /api/orders",
    "body": "Investigation complete: Root cause: missing null check in orders.ts:42 Opened PR: https://github.com/acme/orders/pull/4271"
  },
  "change": { "kind": "agent_completed" },
  "agentRun": {
    "id": "uuid",
    "state": "complete",
    "runtime": "anthropic",
    "completedAt": "2026-05-11T12:34:56.000Z",
    "startedAt": "2026-05-11T12:20:00.000Z",
    "cumulativeRuntimeMinutes": 14,
    "resumeCount": 0,
    "failureReason": null,
    "result": {
      "state": "complete",
      "summary": "Root cause: missing null check in orders.ts:42",
      "rootCauseConfidence": "high",
      "rootCause": {
        "text": "orders.ts:42 dereferences `customer` without checking for null.",
        "confidence": 9
      },
      "estimatedImpact": {
        "text": "~3% of /api/orders requests since deploy at 11:14 UTC.",
        "confidence": 7
      },
      "severity": "SEV-2",
      "pr": {
        "selectedRepoFullName": "acme/orders",
        "branchName": "superlog/fix-orders-typeerror",
        "baseBranch": "main",
        "openStatus": "opened",
        "url": "https://github.com/acme/orders/pull/4271",
        "patch": "diff --git a/orders.ts ...",
        "validationPassed": true
      },
      "linearTicket": {
        "id": "...",
        "url": "https://linear.app/acme/issue/ENG-1234",
        "createdByAgent": true
      },
      "noiseClassification": null,
      "resolutionClassification": null
    }
  },
  "incident": {
    "id": "uuid",
    "title": "TypeError in /api/orders",
    "codename": "squishy-narwhal",
    "status": "open",
    "severity": "SEV-2",
    "service": "orders",
    "firstSeen": "2026-05-11T11:00:00.000Z",
    "lastSeen": "2026-05-11T12:30:00.000Z",
    "issueCount": 14,
    "rootCauseText": "orders.ts:42 dereferences `customer` without checking for null.",
    "rootCauseConfidence": 9,
    "estimatedImpactText": "~3% of /api/orders requests since deploy at 11:14 UTC.",
    "estimatedImpactConfidence": 7,
    "suggestedSeverity": "SEV-2",
    "noiseClassification": null,
    "resolutionClassification": null,
    "findingsAgentRunId": "uuid"
  },
  "events": [
    {
      "id": "uuid",
      "kind": "agent_run_started",
      "summary": "...",
      "detail": { },
      "createdAt": "2026-05-11T12:20:00.000Z"
    }
  ],
  "pullRequests": [
    {
      "id": "uuid",
      "repoFullName": "acme/orders",
      "prNumber": 4271,
      "url": "https://github.com/acme/orders/pull/4271",
      "branchName": "superlog/fix-orders-typeerror",
      "baseBranch": "main",
      "state": "open",
      "title": "[superlog] Fix TypeError in /api/orders",
      "mergedAt": null,
      "closedAt": null
    }
  ],
  "linearTickets": [
    {
      "id": "uuid",
      "workspaceId": "...",
      "ticketId": "...",
      "ticketIdentifier": "ENG-1234",
      "url": "https://linear.app/acme/issue/ENG-1234",
      "title": "Fix TypeError in /api/orders",
      "state": "In Progress"
    }
  ]
}
```

Field notes:

- The `incident` and `agentRun` objects follow the shared shapes in **Common
  envelope** above (that's the source of truth); the example shows
  representative values. The example's `incident` block is abbreviated — the
  real payload includes every field listed under "The incident object".
- `agentRun.state` is always `"complete"` for this change. A failed run sends
  `change.kind = "agent_failed"`; a run whose incident was merged into another
  sends `change.kind = "merged"` instead.
- `agentRun.failureReason` is always `null` here for the same reason.
- `incident.status` is one of `"open" | "resolved" | "autoresolved_noise" | "merged"`.
  Note that `agent_completed` can fire while the incident is still
  `"open"` — the agent run finished, but no one has resolved the incident
  yet.
- `incident.severity` and `agentRun.result.severity` are
  `"SEV-1" | "SEV-2" | "SEV-3" | null`. The incident's `suggestedSeverity`
  mirrors the agent's pick for this run; `severity` is the value the user
  (or worker) settled on.
- `incident.rootCauseText` / `rootCauseConfidence` / `estimatedImpactText` /
  `estimatedImpactConfidence` are flattened from the latest successful
  agent run's `result.rootCause` / `result.estimatedImpact` so the incident
  row is the single source of truth for "what did we learn". The agent
  run's raw `result` jsonb is preserved on `agentRun.result` for audit.
- `agentRun.result.rootCauseConfidence` is the coarse `"high" | "medium" | "low" | null`
  rating. `agentRun.result.rootCause` and `agentRun.result.estimatedImpact`
  are separate objects carrying a free-text `text` plus a numeric `confidence`
  on a 0-10 scale (10 = backed by verbatim code/log/trace/ticket evidence;
  0 = pure speculation).
- `agentRun.result.pr` is present when a PR was opened. Mutually-exclusive
  with the no-PR conclusion fields `agentRun.result.noiseClassification` /
  `agentRun.result.resolutionClassification`, which are set when the agent
  decided not to ship a fix (the issue is noise, or already fixed in the
  current code, or PR policy = never).
- `agentRun.result.linearTicket` is present when Linear is connected and a
  ticket was filed.
- `pullRequests` and `linearTickets` mirror the same underlying records but
  as the persistent state we track (PR state may change after the webhook
  fires — e.g. a PR opened at agent-run-completion time might be merged
  later; that mid-flight state is what's in the payload).
- The `agentRun.result` shape evolves with the agent runtime. Treat unknown
  fields as additive.

## Best practices

- **Respond fast.** Return 2xx within 10 seconds. Do the actual work async.
- **De-dupe** on `Superlog-Delivery`. We may retry a delivery you already
  processed (e.g. your server returned 200 but the connection dropped before we
  saw it).
- **Verify the signature** on every request. Reject if the timestamp drifts
  more than ~5 minutes from your clock.
- **Don't trust the URL host** for routing — anyone with the URL could try to
  POST to it. The HMAC is your only proof.
- **Route on `event`, then `change.kind`.** `incident.created` → start a new
  thread keyed on `incident.id`; `incident.updated` → look up that thread and
  post a reply (or edit), branching on `change.kind`. For the simplest possible
  integration, just forward `message.title` / `message.body` and ignore the rest.
