# Registering a GitHub App for local development

Superlog's agent inspects your repositories and opens pull requests through a
**GitHub App**. The dashboard's **Connect GitHub** / **Refresh access** buttons
drive that integration.

Locally it is **disabled by default**: the GitHub credentials in
`apps/api/.env` and `apps/worker/.env` ship blank, so the API returns `503` from
`/api/github/install-url` and the connect button does nothing. This guide walks
through registering one App and wiring its credentials into both processes so you
can exercise the flow end to end.

> You only need this to test the GitHub integration. Every other part of the
> stack runs fine with these credentials left blank.

## Contents

1. [How the pieces fit](#how-the-pieces-fit)
2. [Create the App](#1-create-the-app)
3. [Permissions](#2-permissions)
4. [Generate credentials](#3-generate-credentials)
5. [Map credentials to env vars](#4-map-credentials-to-env-vars)
6. [Webhooks (optional locally)](#5-webhooks-optional-locally)
7. [Restart and verify](#6-restart-and-verify)
8. [Troubleshooting](#troubleshooting)

## How the pieces fit

The API and the worker are separate Node processes with separate `.env` files.
They talk to the **same** GitHub App but use different parts of it:

| Process | Role | Needs |
| --- | --- | --- |
| **API** (`@superlog/api`) | Builds the install URL, handles OAuth callbacks, verifies webhooks | App **slug**, **client id/secret**, **webhook secret**, App **id** + **private key** |
| **Worker** (`@superlog/worker`) | Mints installation access tokens to push commits and open PRs | App **id** + **private key** |

Setting the credentials on the worker alone is **not** enough: the `503` comes
from the API process, which reads its own env.

## 1. Create the App

Go to **https://github.com/settings/apps → New GitHub App** (or register it under
an org at `https://github.com/organizations/<org>/settings/apps`).

| Field | Value |
| --- | --- |
| **GitHub App name** | anything unique, e.g. `superlog-dev-<yourname>` |
| **Homepage URL** | `http://localhost:5173` |
| **Callback URL** | `http://localhost:4100/github/install/callback` |
| **Callback URL** (add a second) | `http://localhost:4100/github/author/callback` |
| **Request user authorization (OAuth) during installation** | ✅ enabled |
| **Setup URL** (under "Post installation") | `http://localhost:4100/github/install/callback` |
| **Redirect on update** | ✅ enabled |
| **Webhook → Active** | optional locally — see [Webhooks](#5-webhooks-optional-locally) |

### Two callback URLs

The integration uses **two** OAuth callbacks against the same App. GitHub Apps
allow several callback URLs — click **Add callback URL** to register the second.
Register **both**, or the second flow fails with
`The redirect_uri is not associated with this application`:

| Callback URL | Used by |
| --- | --- |
| `http://localhost:4100/github/install/callback` | **Connect GitHub** — install flow |
| `http://localhost:4100/github/author/callback` | **Refresh access** — commit-author OAuth flow |

### The App slug

The **slug** is the identifier GitHub puts in the App's public URL,
`https://github.com/apps/<slug>` — usually your App name lowercased with dashes.
You'll need it for `GITHUB_APP_SLUG`. Set it to the slug **only**
(`superlog-dev-yourname`), not the full settings URL — the API builds
`https://github.com/apps/<slug>/installations/new` from it.

## 2. Permissions

Under **Permissions & events → Repository permissions**, grant the minimum the
agent uses:

| Permission | Access | Used for |
| --- | --- | --- |
| **Contents** | Read & write | read repo files; push the fix branch |
| **Pull requests** | Read & write | open / update / merge PRs |
| **Issues** | Read & write | post PR / issue comments |
| **Metadata** | Read-only | mandatory for all Apps (auto-selected) |

No account or organization permissions are required. (Optionally, grant
**Account permissions → Email addresses: Read-only** if you want the installer's
real email captured instead of a `noreply` fallback.)

## 3. Generate credentials

On the App's settings page, collect:

1. **App ID** — shown near the top of the "About" section.
2. **Client ID** and **Client secret** — under "Client secrets", click
   **Generate a new client secret** and copy both.
3. **Private key** — under "Private keys", click **Generate a private key**. A
   `.pem` file downloads. Store it safely; GitHub won't show it again.
4. **Webhook secret** — only if you enable webhooks (step 5).

## 4. Map credentials to env vars

Add these to your local env files. The App **id** and **private key** are shared
by both processes; everything else is API-only.

### `apps/api/.env`

```ini
GITHUB_APP_SLUG=superlog-dev-yourname           # the <slug> in github.com/apps/<slug>
GITHUB_APP_ID=123456
GITHUB_CLIENT_ID=Iv1.abc123...                  # the App's OAuth Client ID
GITHUB_CLIENT_SECRET=...                         # the App's client secret
GITHUB_APP_WEBHOOK_SECRET=...                    # only needed if webhooks are on
STATE_SIGNING_SECRET=...                          # already set by .env.example

# Both redirect URLs default to http://localhost:4100/github/<install|author>/callback —
# only set these if you changed them:
# GITHUB_INSTALL_OAUTH_REDIRECT_URL=http://localhost:4100/github/install/callback
# GITHUB_AUTHOR_OAUTH_REDIRECT_URL=http://localhost:4100/github/author/callback
```

For the private key, set **one** of these:

```ini
# Option A — inline. Escape newlines as literal \n on a single line:
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"

# Option B — base64. Encode the whole .pem:
#   base64 -i your-app.private-key.pem | tr -d '\n'
GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi...
```

### `apps/worker/.env`

```ini
GITHUB_APP_ID=123456                             # same App ID as the API
GITHUB_APP_PRIVATE_KEY=...                        # same key (inline) ...
# GITHUB_APP_PRIVATE_KEY_BASE64=...               # ... or base64, same as the API
```

> **Note:** the worker reads `GITHUB_APP_PRIVATE_KEY` *or*
> `GITHUB_APP_PRIVATE_KEY_BASE64`, preferring the first. A present-but-empty
> `GITHUB_APP_PRIVATE_KEY=` blocks the base64 fallback — comment it out if you
> use the base64 form.

## 5. Webhooks (optional locally)

Webhooks keep the installation's repo list and PR state in sync **after** the
initial connect. The connect flow itself works without them: the install
callback is a browser redirect that records the installation synchronously.

For a first test you can leave webhooks **off** and skip
`GITHUB_APP_WEBHOOK_SECRET`. Connecting and opening a PR still work; you just
won't get live updates when repos are added/removed or PRs change on GitHub's
side.

To enable them, GitHub needs to reach your machine — point a tunnel at the API:

```bash
# example with smee.io
npx smee-client --url https://smee.io/<channel> --target http://localhost:4100/github/webhook
```

Set the App's **Webhook URL** to the tunnel, set a **Webhook secret**, put the
same value in `GITHUB_APP_WEBHOOK_SECRET`, and subscribe to these events:

`installation`, `installation_repositories`, `pull_request`,
`pull_request_review`, `pull_request_review_comment`, `issue_comment`, `push`.

## 6. Restart and verify

Env is read at boot, so restart **both** the API and the worker after editing
`.env`.

On startup the API logs a warning for each missing piece. A **clean** boot — no
`GITHUB_APP_SLUG not set` line — means the credentials loaded:

```
GITHUB_APP_SLUG not set — /github/install disabled            # ← should be GONE
GITHUB_APP_WEBHOOK_SECRET not set — /github/webhook disabled  # ← OK to remain if webhooks off
```

Then open `http://localhost:5173`, run **Connect GitHub**, and you should be
redirected to GitHub's install screen instead of getting nothing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `POST /api/github/install-url 503` and the button does nothing | `GITHUB_APP_SLUG` (or `STATE_SIGNING_SECRET`) unset in `apps/api/.env`, or the API wasn't restarted after editing it |
| Redirect URL looks like `github.com/apps/https://github.com/settings/...` | `GITHUB_APP_SLUG` is set to the full settings URL — use the slug **only** (`superlog-dev-yourname`) |
| Redirected to GitHub, but the callback errors / returns with `?gh=error` | App **Callback URL** / **Setup URL** doesn't match `http://localhost:4100/github/install/callback` |
| `The redirect_uri is not associated with this application` (e.g. on **Refresh access**) | The App is missing a callback URL. Register **both** `http://localhost:4100/github/install/callback` and `http://localhost:4100/github/author/callback` |
| Install succeeds but the worker can't open a PR (`GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required`) | Credentials missing or empty in `apps/worker/.env`, or the App lacks **Contents: write** / **Pull requests: write** |
| `github webhook signature failed` in API logs | `GITHUB_APP_WEBHOOK_SECRET` doesn't match the secret set on the App |
