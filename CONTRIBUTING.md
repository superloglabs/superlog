# Contributing to Superlog

Thanks for contributing. Superlog is built by a small team, and good contributions get reviewed and merged in hours — your help genuinely shapes the product.

> **First time contributing to open source?** Take a look at [firstcontributions/first-contributions](https://github.com/firstcontributions/first-contributions) for a 5-minute walkthrough of the fork → branch → PR flow. The mechanics are the same here.

## Ways to contribute

You don't have to write code to help:

- **Report bugs and edge cases** — open an issue with a minimal repro
- **Improve docs** — this file, the [docs/](docs/) folder, in-code comments
- **Write tests** — overall coverage is ~44%; several surfaces in `apps/api` and `apps/worker` have none
- **Triage issues** — reproduce, label, link duplicates
- **Send PRs** — see the workflow below
- **Help in Discord** — `#support` is where new users land first
- **Spread the word** — write about how you use Superlog

## Code of conduct

This project follows the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/): be respectful, assume good faith, focus on the work. We don't ship a separate `CODE_OF_CONDUCT.md` yet — if you want to add one, propose it in an issue first.

## Prerequisites

- **Node.js 20+** — `node --version`
- **pnpm 9+** — the repo pins `pnpm@9.12.0` via `packageManager`
- **Docker** with `docker compose` (for Postgres, ClickHouse, and the OTel collector)
- A GitHub account with SSH or HTTPS auth

## Quick start

```bash
git clone https://github.com/superloglabs/superlog.git
cd superlog
pnpm install
docker compose up -d
pnpm --filter @superlog/db db:migrate
pnpm dev
```

Default local services:

| Service      | URL                       |
| ------------ | ------------------------- |
| Web app      | http://localhost:5173     |
| API          | http://localhost:4100     |
| OTLP proxy   | http://localhost:4101     |
| Sample app   | http://localhost:3005     |

If something fails on first boot, run `pnpm dev:portless:status` to see what came up. For a clean restart:

```bash
pnpm dev:portless:stop && pnpm dev:portless
```

The `dev:portless*` family uses per-worktree ports and a per-worktree database, which keeps parallel worktrees from colliding. See `scripts/portless-stack.sh` for details.

## Repository layout

```
apps/
  api/      Hono HTTP API
  proxy/    OTLP intake proxy
  web/      Vite/React frontend
  worker/   Background workers + agent orchestration
  sample/   Next.js 15 example app that ships OTel traces to Superlog
packages/
  db/         Drizzle schema + Postgres migrations
  fingerprint Telemetry fingerprinting helpers
  billing     Autumn billing integration
scripts/
  demo/         Seed scripts for local development
  worktree-*    Per-worktree port + DB isolation
  portless-*    Stack orchestration
  smoke-*.ts    Manual smoke tests (gRPC, OTLP)
docs/           Currently only webhooks.md — more coming
```

## Common commands

| Command                                       | What it does                                              |
| --------------------------------------------- | --------------------------------------------------------- |
| `pnpm dev`                                    | Run all apps via Turborepo                                |
| `pnpm dev:portless`                           | Run with per-worktree port + DB isolation (recommended)   |
| `pnpm dev:portless:env`                       | Print the env vars the portless stack sets                |
| `pnpm build`                                  | Build all packages                                        |
| `pnpm typecheck`                              | TypeScript across the monorepo (Turbo)                    |
| `pnpm lint`                                   | Biome check (read-only)                                   |
| `pnpm format`                                 | Biome format --write                                      |
| `pnpm --filter @superlog/<pkg> <script>`      | Run a script in one package                               |
| `pnpm --filter @superlog/db db:migrate`       | Apply Postgres migrations                                |
| `pnpm demo:bootstrap:acme`                    | Create a demo Acme Inc. org + project                     |
| `pnpm demo:seed:acme`                         | Seed Acme Inc. telemetry (good first-time demo)           |
| `pnpm demo:seed:rich`                         | Seed richer demo data with multiple signals               |
| `pnpm demo:seed:everything`                   | Seed everything                                           |
| `pnpm conductor:setup`                        | One-time setup for the Conductor dev environment          |
| `pnpm worktree:bootstrap`                     | Bootstrap a new git worktree (port + DB + telemetry)      |

## Testing

Tests use Node's built-in test runner via `tsx`:

```bash
pnpm --filter @superlog/api test
pnpm --filter @superlog/fingerprint test
pnpm --filter @superlog/billing test
```

Place new tests next to the source as `*.test.ts` — the existing `tsx --test src/**/*.test.ts` glob picks them up automatically. Run `pnpm typecheck` before opening a PR; TypeScript is strict (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).

If your change touches OTLP ingestion, agent orchestration, webhook delivery, or incident lifecycle, add at least one test. These are the surfaces that matter most for users.

## Environment variables

Per-app `.env.example` files are the source of truth — copy each to `.env` (or use `scripts/with-stack-env.sh` to source them all at once) and fill in the secrets you need:

| File                                       | What it covers                                           |
| ------------------------------------------ | -------------------------------------------------------- |
| [`apps/api/.env.example`](apps/api/.env.example)       | API, auth, billing, email, Slack/Linear OAuth, Loops    |
| [`apps/worker/.env.example`](apps/worker/.env.example) | Agent runner, GitHub App, Linear, ClickHouse polling    |
| [`apps/web/.env.example`](apps/web/.env.example)       | Vite/React client env vars                              |
| [`apps/proxy/.env.example`](apps/proxy/.env.example)   | OTLP proxy                                              |
| [`packages/db/.env.example`](packages/db/.env.example) | Local DB connection                                    |
| [`apps/sample/.env.local.example`](apps/sample/.env.local.example) | Sample app OTel exporter config        |


If a variable is missing from the per-app examples, check `apps/api/src/env.ts` or the relevant `*.test.ts` setup file before guessing.

## Code style

The repo uses **Biome** (not ESLint/Prettier). Full config in `biome.json`:

- 2-space indent, 100-char line width
- Double quotes, semicolons, trailing commas
- `import` ordering is enforced — run `pnpm format` to autofix

`pnpm lint` is read-only. `pnpm format` rewrites files. Before pushing a PR, both should pass — `pnpm typecheck` is the strictest gate.

## Commit messages and branch names

Branch names follow `<your-handle>/<kebab-summary>`:

```
your-github-username/short-kebab-description
arseniycodes/mcp-install-pill
ash/slack-private-channels
```

PR titles in this repo use a mix of styles — match the area you're touching:

| Style                          | Example                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `area: imperative summary`     | `fingerprint: add tsx to lockfile`, `worker: add pgboss:migrate`            |
| `fix(area): summary`           | `fix(slack): use the incident's pinned installation for interactivity buttons` |
| `feat(area): summary`          | `feat(worker): link filed Linear ticket in agent-opened PR body`            |
| Plain English (cross-cutting)  | `Add AWS connect + resource inventory`                                      |

Keep the subject under 72 chars. Use the body for the *why* — the diff shows the *what*.

## Pull requests

1. **One concern per PR.** If you're fixing a bug and notice an unrelated cleanup, send it as a second PR.
2. **Open a draft early** if the change is non-trivial — a draft gets eyes faster.
3. **Reference the issue** in the PR description (`Fixes #38`) so it auto-closes.
4. **Run before pushing**:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm --filter @superlog/<affected-pkg> test
   ```
5. **Keep PRs small.** Under ~400 lines is the sweet spot. Big PRs get bounced.
6. **Address review fast.** Turnaround on follow-up commits is typically under 24 hours.

### What we won't (typically) merge

- Drive-by formatting or typo-only PRs with no real fix
- Large refactors or rewrites — open an issue first to align on direction
- Changes to OTLP ingestion, agent orchestration, webhooks, or incident lifecycle without tests
- PRs that add a new runtime dependency without a strong justification
- Anything that touches billing (`packages/billing/`) or auth (`apps/api/src/auth.ts`) without prior discussion

If you're not sure whether a change fits, open an issue first. It's much cheaper than opening a PR and being told to re-do it.

## Filing issues

- **One issue per bug.** Multiple things in one issue slow down triage and resolution.
- **For bugs:** include a minimal repro, expected vs. actual, your environment (`pnpm dev:portless:status` output), and the relevant log line.
- **For feature requests:** explain the use case first, then the proposed change. Smaller scope = faster review.
- **For support questions:** use [Discord](https://discord.gg/wJ56aRh8xh) `#support`, not issues. Issues are for bugs and feature requests only.
- **For security:** see [SECURITY.md](SECURITY.md) — do not file a public issue.

### Issue labels

| Label               | Meaning                                       |
| ------------------- | --------------------------------------------- |
| `bug`               | Confirmed or likely defect                    |
| `documentation`     | Docs-only change                              |
| `enhancement`       | New feature or improvement                    |
| `good first issue`  | Scoped for first-time contributors            |
| `help wanted`       | Maintainer would love a PR                    |
| `duplicate`         | Already reported                              |
| `invalid`           | Not actionable as filed                       |
| `question`          | Needs clarification                           |
| `wontfix`           | Out of scope or by design                     |

Not every issue gets a label — if none is set, the maintainers will triage.

## Generative AI policy

Generative AI tools are welcome for **understanding** the codebase, **brainstorming** approaches, and **proofreading** your PR descriptions. The resulting contribution is yours — understand and verify what you submit.

**Disclose significant AI use in your PR description** (one line is enough), for example:

> Used Claude to scaffold the test cases for `webhooks.ts`; reviewed and adapted manually.

**Don't** use AI to:

- Submit code, issues, or comments you don't understand
- Solve problems you couldn't have solved without it
- Mass-open issues or PRs
- Impersonate a human contributor (e.g. fake "Co-authored-by" trailers, fake review replies)

Maintainers may close low-value AI-generated PRs without detailed feedback. The bar for AI-assisted work is the same as for human-written work: it has to be something you understand and can defend.

## What to expect after you submit

- **First response:** usually within a few hours, often the same day. If you don't hear back in 2 business days, ping `#general` in [Discord](https://discord.gg/wJ56aRh8xh).
- **Review:** often request-changes style ("address these 3 nits, then merge"). Turnaround on follow-ups is typically under 24 hours.
- **Merge:** squash or rebase, per the project's GitHub settings.
- **Release:** changes ship in waves — not every PR is user-visible.

We review PRs in service of the product and the team. If an idea doesn't fit, we'll explain why — but the maintainers have final say on what merges. This is normal for a small team, not a rejection of you as a contributor.

## Security

Report vulnerabilities to the addresses listed in [`SECURITY.md`](SECURITY.md). Please do not file a public issue.

## Getting help

- [Discord](https://discord.gg/wJ56aRh8xh) — `#general` for usage, `#support` for setup issues
- GitHub issues for bugs and feature requests
- When opening an issue, include the output of `pnpm dev:portless:status` and a minimal repro

## Recognition

Contributors are credited in release notes and on the [contributors graph](https://github.com/superloglabs/superlog/graphs/contributors). Repeated, high-quality contributions earn commit rights.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE.md).
