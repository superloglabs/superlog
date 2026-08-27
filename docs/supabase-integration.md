# Supabase integration

Superlog can connect multiple hosted Supabase accounts and projects to one
Superlog project. Each selected Supabase project gets its own environment label
(for example `production`, `staging`, or `development`).

The integration does not accept a Postgres connection string. It uses Supabase
OAuth and the hosted Management API with exactly these scopes:

- `projects:read` discovers the projects the user can access.
- `database:read` runs the query-metrics statement through Supabase's dedicated
  read-only database query endpoint.

The worker reads the top normalized statements from `pg_stat_statements` every
five minutes and forwards cumulative calls, rows, execution time, and block I/O
as OTLP metrics. OAuth tokens and per-connection ingest keys are encrypted at
rest. Removing a project connection revokes its ingest key; removing an account
also stops every connection using that grant.

## Configure the OAuth application

Register an OAuth application with this callback URL:

```text
https://<api-origin>/supabase/oauth/callback
```

Set the following API environment variables:

```text
SUPABASE_CLIENT_ID=<oauth-client-id>
SUPABASE_CLIENT_SECRET=<oauth-client-secret>
SUPABASE_OAUTH_REDIRECT_URI=https://<api-origin>/supabase/oauth/callback
```

The worker needs the same client id and secret so it can refresh grants while
polling. `SUPABASE_INTAKE_URL` optionally points it at the proxy intake origin;
local development defaults to the local proxy.

`AGENT_SECRETS_KEY` and `STATE_SIGNING_SECRET` must also be configured. Without
all four secrets, the integration remains visible as unavailable rather than
starting a partial OAuth flow.

## Optional MCP access

The settings page exposes a project-scoped Supabase MCP URL for each connection.
It sets `read_only=true` and limits features to database and debugging tools.
This is optional investigation access; query-metrics collection does not depend
on MCP.

Self-hosted Supabase and generic Postgres databases are intentionally outside
this integration's scope.
