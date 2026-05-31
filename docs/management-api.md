# Nanocorp integration guide

How to run Superlog as the observability layer for a platform that spins up many independent companies. One Superlog org per Nanocorp account, one Superlog project per company. Companies are fully isolated — telemetry, GitHub access, dashboards, alerts — but billing and the GitHub App install live at the org level.

Two parts:

1. **One-time setup** — connect Superlog's GitHub App to Nanocorp's GitHub org. Done manually by an admin.
2. **Per-company onboarding** — driven by an agent that talks to Superlog's management API. Includes a drop-in prompt.

## 1. One-time setup

Done once when Nanocorp signs up. Two manual steps, both by a human admin.

### 1a. Mint a management API key

From the Superlog dashboard: **Settings → Management API keys → Create key**.

The plaintext (`sl_management_…`) is shown **once** at creation. Put it in your secrets manager — this is the credential the company-onboarding agent will use for every API call. If lost, revoke and mint a new one.

> **Treat it like a root credential.** A management key can create projects, mint telemetry ingest keys, and grant GitHub repos to projects. It cannot see other Nanocorp accounts.

### 1b. Install the Superlog GitHub App on Nanocorp's GitHub org

Run this once with the management key, then click through GitHub's consent:

```bash
KEY=$(cat /path/to/management-key)

curl -X POST https://api.superlog.sh/api/v1/integrations/github/install-url \
  -H "Authorization: Bearer $KEY"
```

You get back an `install_url`. Open it in a browser, pick the Nanocorp GitHub org, grant access to the repos your companies will live in (or "all repos" if Nanocorp's GitHub org *only* holds company repos). After install, GitHub bounces back to the Superlog dashboard.

> The state in the URL has a **30-minute TTL**. If you don't click within 30 min, mint a fresh URL and try again.

Verify the install landed:

```bash
curl https://api.superlog.sh/api/v1/integrations/github/installations \
  -H "Authorization: Bearer $KEY"
```

You should see one entry with `account_login: "nanocorp"` (or whatever the GitHub org is called). Note its `id` — companies will get repo grants pointing at this install.

That's the entirety of the manual setup. Everything below is automated.

## 2. Per-company onboarding agent

Nanocorp runs an agent (Claude Code, or any agent with bash + edit tools) that handles a new company end-to-end. The agent takes a company name + a GitHub repo, calls Superlog's management API to provision, grants the repo, mints an ingest key, then hands the OpenTelemetry instrumentation off to the `superloglabs/skills` package — which Superlog already publishes and uses for self-serve onboarding. The skill consumes the ingest key from the prompt and skips signup.

### Agent system prompt (drop-in)

```
You are Nanocorp's company-onboarding agent. Your job is to provision a new
company on Superlog so its telemetry, agent runs, and PRs all flow to the
right place.

Inputs per invocation:
- company_name: human-readable name, e.g. "Acme Corp"
- company_slug: kebab-case identifier, e.g. "acme-corp"  (must match
  ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$, max 40 chars)
- github_repo_id: the numeric GitHub repo id this company owns, e.g. 1205197508
- github_repo_full_name: e.g. "nanocorp/acme-corp"
- company_repo_local_path: the local path where the repo is already cloned

Environment:
- SUPERLOG_API_BASE = "https://api.superlog.sh"
- SUPERLOG_MGMT_KEY = (provided in env, starts with sl_management_)
- SUPERLOG_GITHUB_INSTALLATION_ROW_ID = (provided in env, the Superlog
  installation row id for Nanocorp's GitHub install — UUID format)

Recipe (run in order, stop and report error on any non-2xx):

1. Create the project + mint an ingest key in one call.
   POST $SUPERLOG_API_BASE/api/v1/projects
   { "name": company_name, "slug": company_slug, "mint_ingest_key": true }
   - On 409 "slug already in use", report back and stop.
   - Capture `project.id` and `api_key.plaintext` from the response. Treat
     `api_key.plaintext` as a secret: hand it to the next step and don't
     log it.

2. Grant GitHub access for the company's repo.
   POST $SUPERLOG_API_BASE/api/v1/projects/{project.id}/github/repos
   { "installation_id": SUPERLOG_GITHUB_INSTALLATION_ROW_ID,
     "repo_id": github_repo_id }
   - On 404, verify the repo is actually covered by the Nanocorp install
     (GET /api/v1/integrations/github/installations/{installation_id}/repos)
     and report.

3. Instrument OpenTelemetry in the company's repo.
   - cd to company_repo_local_path
   - Execute exactly this prompt against an interactive Claude Code session
     in that directory:

       Run `npx skills add superloglabs/skills --all` and use the skills to
       install Superlog in this project.
       Use API key {api_key.plaintext}.

   - The skill will detect language/services, add an OTel exporter
     configured for $SUPERLOG_API_BASE, commit the changes, and open a PR.
     It does not trigger signup — providing the key in the prompt is what
     tells it to skip device pairing.
   - Capture the PR URL the skill prints.

4. Report success.
   Return: { project_id, project_slug, ingest_key_prefix,
             github_repo_full_name, otel_pr_url }

All Superlog API requests include:
  Authorization: Bearer $SUPERLOG_MGMT_KEY

Never log the ingest_key plaintext or the management key after handing it
to step 3. The skill writes the key into the company's runtime config (a
Vercel env var, Railway secret, etc.) and from there it lives in their
secrets manager.
```

### Notes on the skill step

The `superloglabs/skills` package is the same one self-serve users run. Providing the API key inline in the prompt is how you tell it to use that key instead of pairing a device — there's a `buildInstallPrompt(apiKey)` helper in the Superlog web app that produces exactly the prompt above for users coming through the dashboard.

This means improvements to OTel best practices (new language support, better service detection, etc.) ship as skill version bumps — no agent prompt changes needed on Nanocorp's side.

## API reference

Everything the company-onboarding agent (and any other Nanocorp automation) needs to call.

### Projects

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/projects` | Body: `{name, slug, mint_ingest_key?: boolean=true}`. Slug is `[a-z0-9]([a-z0-9-]*[a-z0-9])?`, max 40 chars. Returns project + (optionally) initial ingest key. 409 on slug collision. |
| `GET` | `/api/v1/projects` | List all projects in the authed org. |
| `GET` | `/api/v1/projects/:id` | Fetch one. 404 if not in the authed org. |

### Project ingest keys

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/projects/:id/api-keys` | Body: `{name?: string}`. Mint additional ingest keys. Plaintext returned only once. |
| `GET` | `/api/v1/projects/:id/api-keys` | List. Plaintexts not returned (only prefix/metadata). |

### GitHub install URLs

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/integrations/github/install-url` | Body: `{return_url?: string}`. Mints **org-scoped** install URL. 30-min state TTL. `return_url` must be on the org's allowlist (managed by a dashboard admin via `PUT /api/org/return-url-hosts`) or omitted. |
| `POST` | `/api/v1/projects/:id/integrations/github/install-url` | Same but **project-scoped** — install lands private to the named project, no grants needed. Used when a company has its own dedicated GitHub install rather than sharing Nanocorp's. |

### GitHub install discovery

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/integrations/github/installations` | List org-scoped installs only. Project-scoped installs are private to their project and intentionally excluded. |
| `GET` | `/api/v1/integrations/github/installations/:rowId/repos` | Live-fetch covered repos. Capped at 1000 with `truncated` flag; grants still work for repos past the cap (the grant endpoint does an O(1) GitHub lookup). |

### Repo grants

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/projects/:id/github/repos` | Body: `{installation_id, repo_id}`. Repo is verified against GitHub before persistence. |
| `DELETE` | `/api/v1/projects/:id/github/repos/:repoId` | Revoke. 404 if grant doesn't exist. |
| `GET` | `/api/v1/projects/:id/github/repos` | List active grants (excludes those whose install was revoked). |

## Isolation guarantees

- **Telemetry**: project ingest keys are project-scoped. The collector stamps `superlog.project_id` from the key and every read query filters on it. A company's ingest key cannot write to another company's project, and a company's reads cannot see another company's telemetry.
- **GitHub**: tokens are minted per-repo at request time. Even within Nanocorp's shared org-scoped install, a company's agent tokens can only touch repos that company has been granted.
- **Cross-org**: management keys are scoped to their org. They cannot list, mutate, or even probe for the existence of resources in other Superlog orgs (404 returned for any cross-org reference).

## Common errors

| Status | Body | Cause |
|---|---|---|
| 401 | `{"error": "missing bearer token"}` | No `Authorization` header. |
| 401 | `{"error": "wrong credential type: /api/v1/* requires an sl_management_* key"}` | Used a `sl_public_*` ingest key or other token type. |
| 401 | `{"error": "invalid or revoked key"}` | Management key was revoked or never existed. |
| 400 | `{"error": "slug must be lowercase alphanumeric + dashes, max 40 chars"}` | Bad slug in `POST /projects`. |
| 409 | `{"error": "slug already in use in this org"}` | Duplicate slug. |
| 404 | `{"message": "project not found"}` | Project doesn't exist OR is in another Superlog org. |
| 404 | `{"message": "org-scoped installation not found"}` | Install row doesn't exist, is in another org, is project-scoped, or is revoked. |
| 404 | `{"message": "repo not covered by this installation"}` | Repo isn't in the GitHub install's covered set. Verify with `GET .../installations/:id/repos`. |
| 400 | `{"error": "return_url host \"…\" is not in this org's return URL allowlist"}` | Add the host via `PUT /api/org/return-url-hosts` first. |
| 502 | `{"message": "failed to verify repo against github"}` | Transient GitHub API failure; retry. |
