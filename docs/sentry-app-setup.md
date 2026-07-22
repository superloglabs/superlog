# Sentry Cloud integration setup

The Sentry connector uses a public Sentry App. It listens for newly created and
regressed issues, then gives investigation agents read-only access to the
connected Sentry project's issues, events, traces, logs, metrics, profiles,
replays, and performance context through Sentry's hosted MCP server.

Self-hosted Sentry is not supported.

## Create the Sentry App

In Sentry Cloud, create a public custom integration with:

- read access for organizations, projects, teams, and events (`org:read`,
  `project:read`, `team:read`, `event:read`);
- issue webhook subscriptions for `issue.created` and `issue.unresolved`;
- webhook URL `https://<api-host>/sentry/webhook`;
- redirect URL `https://<api-host>/sentry/oauth/callback`.

The callback supports both immediately installed apps and Sentry's verified
installation flow.

Superlog discovers the projects available in the organization selected during
OAuth. A single project connects automatically. When the organization has
multiple projects, the OAuth grant stays encrypted on the server while the user
chooses one from a short-lived project picker. No Sentry organization or project
slug has to be copied into Superlog.

## Configure the API

Set these variables on the API service:

```text
SENTRY_APP_SLUG=<public-app-slug>
SENTRY_CLIENT_ID=<oauth-client-id>
SENTRY_CLIENT_SECRET=<oauth-client-secret>
SENTRY_OAUTH_REDIRECT_URL=https://<api-host>/sentry/oauth/callback
```

`STATE_SIGNING_SECRET` and `AGENT_SECRETS_KEY` are also required. OAuth and relay
credentials are encrypted at rest with `AGENT_SECRETS_KEY`.

The webhook endpoint verifies `Sentry-Hook-Signature` over the raw request body
before accepting an event. The issue event is persisted idempotently and handled
asynchronously, so the endpoint can acknowledge Sentry quickly.
