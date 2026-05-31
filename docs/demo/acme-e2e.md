# Acme E2E Demo Runbook

This runbook provisions `Acme` in local and prod, seeds static telemetry into both, and uses local as the active debug environment for the first end-to-end run.

## Prerequisites

- local infra and app stack available through `docker compose up -d` and `overmind start -D`
- valid app credentials for local and prod:
  - Anthropic
  - GitHub App
  - Slack OAuth + signing secret
- `ngrok` available for exposing the local API callbacks
- GitHub org `superlog-demo` with repository `storefront`

## 1. Create the standalone demo repo

Use [demo/acme-storefront-demo](/Users/arseniyshishaev/projects/superlog/demo/acme-storefront-demo) as the source of truth.

1. Create or reuse the repository `superlog-demo/storefront`.
2. Copy the contents of `demo/acme-storefront-demo/` into that repository.
3. Run `pnpm install`.
4. Commit and push.

The demo repo intentionally contains one broken route:

- `GET /api/healthy` should always pass
- `GET /api/broken2` should fail until the agent run fixes it

## 2. Bootstrap Acme locally

Run:

```bash
DATABASE_URL=postgres://... \
pnpm demo:bootstrap:acme -- \
  --target local \
  --owner-email you@example.com \
  --owner-clerk-id clerk_user_id
```

Save the output:

- `org.id`
- `project.id`
- plaintext ingest API key

## 3. Bootstrap Acme in prod

Run the same script against prod:

```bash
DATABASE_URL=postgres://... \
pnpm demo:bootstrap:acme -- \
  --target prod \
  --owner-email you@example.com \
  --owner-clerk-id clerk_user_id
```

Save the prod project id and prod ingest API key.

## 4. Seed one-shot telemetry

### Local

```bash
pnpm demo:seed:acme -- \
  --target local \
  --ingest-url http://localhost:4000 \
  --api-key sl_public_...
```

### Prod

```bash
pnpm demo:seed:acme -- \
  --target prod \
  --ingest-url https://your-prod-ingest.example.com \
  --api-key sl_public_...
```

Expected result:

- dashboards show non-zero logs and metrics
- no issues/incidents are created from the seeded data

## 5. Local callback mapping with ngrok

Expose the local API port with `ngrok`.

Map the public URL to:

- GitHub App callback: `/github/install/callback`
- GitHub webhook: `/github/webhook`
- Slack OAuth redirect: `/slack/oauth/callback`
- Slack events: `/slack/events`
- Slack interactivity: `/slack/interactivity`

Update the local env values before restarting the stack:

- `WEB_ORIGIN`
- `SLACK_OAUTH_REDIRECT_URL`
- any local GitHub App callback or webhook settings that currently assume localhost

## 6. GitHub install steps

Do these for both local and prod app installations:

1. Install the app into the GitHub org `superlog-demo`.
2. Restrict access to `superlog-demo/storefront`.
3. Confirm the installation webhook succeeds.
4. Confirm the matching `github_installations.repos` entry contains the demo repo.

## 7. Slack route steps

Do these for both local and prod:

1. Sign into the dashboard as the Acme owner.
2. Connect Slack.
3. Set the project Slack route for `Acme / Storefront`.
4. Confirm the route points to the intended demo channel.

## 8. Local live debug run

Configure the standalone demo repo:

```bash
cp .env.local.example .env.local
```

Set the local ingest key in `.env.local`, then start the app:

```bash
pnpm dev
```

Trigger the incident:

```bash
curl -i http://localhost:3005/api/broken2
```

Observe:

- worker logs in `tmp/logs/worker.log`
- Slack thread creation
- `GET /api/projects/:projectId/incidents` (includes `agentRun`, `agentRuns`, and `timeline` in the response)
- `GET /api/projects/:projectId/incidents/:incidentId` (single round trip — findings, timeline, and run history all in one payload)
- PR creation in the demo repo

## 9. Prod readiness checklist

Before attempting the prod live run, verify:

- Acme org exists
- Storefront project exists
- automation enabled
- prod ingest key works
- seeded logs/metrics visible
- GitHub install present and repo list populated
- Slack route configured
- prod callback URLs reachable
- Anthropic and GitHub write credentials configured for the prod worker

## 10. Prod live run checklist

Only after local is stable:

1. Point the standalone demo repo at prod ingest with the prod Acme API key.
2. Trigger `/api/broken2`.
3. Verify the same flow completes in prod:
   - issue
   - incident
   - Slack thread
   - agent run
   - PR
