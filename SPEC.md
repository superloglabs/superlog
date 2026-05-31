# Superlog — Spec (v0)

OpenTelemetry-compatible observability backend with agent-driven install and agent-driven investigation loop. Ship OTel data in, get PRs out.

## Positioning

Every observability vendor promises "5 minute setup" and lies. Agents can actually do it. The same agent muscle closes the loop on the other side: issue → incident → investigation → PR or human handoff. OTel in, fixes out.

Deliberately betting on OTel standard for ingest — no proprietary SDK. Differentiation is at the ends: install agent (front) and fix agent (back).

## Scope

### In scope (MVP)

- OTLP/HTTP ingest for **logs, traces, metrics** (OTLP/gRPC deferred — see Ingest section).
- ClickHouse storage.
- Local install wizard (`npx superlog init`) that instruments customer apps.
- Error fingerprinting (stack-trace based) — "issues."
- Conservative issue-to-incident grouping with human-readable investigation threads.
- Managed investigation agent per incident, running in Anthropic Managed Agents.
- GitHub app for PR creation.
- Slack integration for incident notifications, investigation updates, human replies, and PRs.
- Minimal UI: incidents list + drill-in (linked fingerprints, traces, PR).

### Out of scope (for now)

- Self-hosting.
- Rich UI (dashboards, custom explorers, SLOs, on-call, alerting beyond Slack).
- Auto-merge of fix PRs (auto-open only).
- LLM-based cross-trace root-cause clustering (v2).
- Proprietary SDKs.

## Architecture

```
customer app ──OTLP──▶ ingest ──▶ ClickHouse
                                    │
                                    ▼
                         fingerprinting + incident grouping
                                    │
                                    ▼
                              incident created
                                    │
                                    ▼
                    Managed investigation session (1 per incident)
                                    │
                        ┌──────────────┼──────────────┐
                        ▼              ▼              ▼
                    ready_to_pr   awaiting_human   failed/stalled
                    PR + Slack    Slack thread     Slack summary
                                  resume loop
```

### Ingest

- OTLP/HTTP endpoint, public. OTLP/gRPC deferred post-MVP — our auth proxy is HTTP-only (Hono), and adding a gRPC-aware auth layer (Envoy ext_authz or Node gRPC proxy) is not worth the time until a customer is throughput-bound.
- Write path: auth proxy → OTel Collector (contrib) with ClickHouse exporter → ClickHouse (tables auto-created: logs, traces, metrics\_{gauge,sum,histogram,summary,exp\_histogram}).
- Auth: API key in `x-api-key` or `Authorization: Bearer`. Proxy validates against Postgres (SHA-256 hash lookup), stamps `x-superlog-project-id` header; Collector promotes it to resource attribute via `attributes` + `groupbyattrs` processors.
- No custom SDK. Customers send OpenTelemetry; we accept it.

### Storage

- ClickHouse. Standard choice in this space (SigNoz, Uptrace, HyperDX reference). Columnar, cheap, fine for all three signals.

### Install agent (`npx superlog init`)

- Local wizard, runs on customer's dev machine.
- Detects language/framework, installs the right OTel SDK, sets `OTEL_EXPORTER_OTLP_ENDPOINT` + auth env vars, verifies data arrives.
- Lower trust cost than a GitHub app for first touch. GitHub-app install path is a later addition, not a replacement.

### Fingerprinting, incidents, and investigations

**Layer 1 — Issues (fingerprints).** Sentry-style: normalize stack frames (strip line numbers, normalize paths), group by exception type + top-N frames. Deterministic, cheap, always runs. Each issue stores normalized frames plus the latest representative sample so later investigation does not depend on re-deriving raw evidence.

**Layer 2 — Incidents.** Investigations run on incidents, not issues. One incident may contain several related issue fingerprints; one investigation runs per incident.

MVP incident grouping is intentionally conservative. A `new` or `regressed` issue joins an open incident only when all of the following are true:

- same project,
- same service when service is known,
- incident first-seen time within 15 minutes,
- at least 2 shared normalized frames from the top 5 frames.

Otherwise a new incident is created.

If more issues join an incident while an investigation is active, the system updates the Slack thread and steers the existing session with an incident delta instead of spawning a second run.

### Managed investigation runtime

Runtime: **Anthropic Managed Agents** first, behind a provider adapter boundary.

- Session per incident.
- Built-in file and shell tools in an isolated environment.
- Runtime remains steerable with follow-up messages when new issue evidence arrives or a human replies in Slack.
- OpenAI remains a future adapter path, not the first implementation.

**Repo discovery is per investigation.** The system does not persist a project-level repo mapping. Instead it:

1. enumerates GitHub App repos for the org,
2. scores them from service-name tokens, normalized frame path tokens, and code-surface hints,
3. mounts only the top 3 candidates into the managed session,
4. asks a human in Slack when no repo clears the threshold.

**Investigation states:**

- `queued`
- `repo_discovery`
- `running`
- `awaiting_human`
- `ready_to_pr`
- `pr_opened`
- `completed`
- `failed`
- `stalled`

**Confidence gate rule:** no PR unless the run selected a repo confidently, reproduced or otherwise concretely validated the bug, produced a patch, and passed post-fix validation.

**Budgeting:** one active investigation per incident, 90 minutes cumulative runtime, and 3 human resume cycles by default.

### GitHub integration

- GitHub app. Read for source access; write for PR creation.
- Managed agents do not receive GitHub write credentials.
- The agent returns a validated patch bundle; the orchestrator reapplies the patch in a fresh clone, reruns validation, then opens the PR through the GitHub app.
- Auto-open PR on high-confidence fix only. Labeled clearly as AI-generated. Not auto-merged — human hits merge.
- Optional: one-click revert from Slack (post-merge safety).

### Slack integration

- One root message per incident.
- Investigation milestones are posted into the thread: repo selected, reproduction result, hypothesis change, awaiting human, resumed, gate passed, PR opened, terminal failure.
- Any non-bot reply in an `awaiting_human` thread becomes authoritative human input and resumes the same managed session.
- Interactive actions remain optional; thread replies are the main human handoff path.

### UI

Intentionally minimal for MVP. No explorers, no dashboards.

- Incidents list.
- Drill-in: linked fingerprints, representative traces, investigation output, PR link.

That's it. Observability UI is not the wedge.

## Non-goals

- Replacing Datadog/Honeycomb feature-for-feature. UI parity is not the pitch.
- Self-hosting. Cloud-only until further notice.
- Custom SDKs. OTel only.

## Open questions

1. **Languages at launch.** Install-agent quality is per-language and cannot be faked. Pick 2–3 to be great at. (JS/TS, Python, Go likely candidates — not decided.)
2. **Pricing.** Not prioritized right now. Revisit before GA.
3. **Agent runtime isolation guarantees.** Confirm per-session filesystem/network isolation before onboarding first real customer.
4. **Future runtime adapters.** When to add OpenAI alongside Anthropic, and whether adapter-specific capabilities materially change the orchestration contract.
5. **Incident clustering v2.** Whether to add deploy correlation, trace-graph correlation, or LLM-assisted clustering after the conservative same-service/time-window/frame-overlap heuristic.
