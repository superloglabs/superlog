# Webhooks

Superlog sends webhooks to your server when interesting things happen in a
project. Today we ship exactly one event:

| Event                  | Fires when                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `agent_run.completed`  | An agent run on an incident finishes with findings — either a PR was opened, or the agent reached a no-PR conclusion (noise / already resolved / PR policy = never). Not fired when an agent run is closed because its incident was merged into a duplicate. |

> **Breaking change (May 2026):** the event name was renamed from
> `investigation.completed` to `agent_run.completed` as part of merging the
> incident and investigation concepts. Existing endpoints' `enabled_events`
> are migrated automatically; update any client-side switch / filter on the
> event name to match.

## Configuring an endpoint

Go to **Settings → Webhooks** for the project that should send the event.

1. Paste your endpoint URL (`https://...`).
2. Click **Add endpoint**. Superlog generates a signing secret prefixed `whsec_`
   and shows it to you once. Copy it — we never display it again.
3. Use **Send test** to fire a sample payload right away. The delivery shows up
   in the live log under the endpoint.

You can rotate the secret at any time, disable an endpoint (deliveries are
suspended but state is preserved), or delete it (deletes all delivery history).

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
  `{ event, eventId, occurredAt, test: true, message, project }` — it shares
  transport, signature, and retry behavior with real events but does not
  include `agentRun`, `incident`, `events`, `pullRequests`, or
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
| `Superlog-Event`        | Event type, e.g. `agent_run.completed`                 |
| `Superlog-Delivery`     | UUID of this delivery — stable across retries          |
| `User-Agent`            | `Superlog-Webhooks/1.0`                                |

## `agent_run.completed` payload

```json
{
  "event": "agent_run.completed",
  "eventId": "5f0a6b6e-...",
  "occurredAt": "2026-05-11T12:34:56.000Z",
  "project": { "id": "uuid", "name": "Default", "slug": "default" },
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

- `agentRun.state` is always `"complete"` for this event. Failed agent runs
  and runs whose incident was merged into another do not fire a webhook.
- `agentRun.failureReason` is always `null` here for the same reason.
- `incident.status` is one of `"open" | "resolved" | "autoresolved_noise" | "merged"`.
  Note that an `agent_run.completed` can fire while the incident is still
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
