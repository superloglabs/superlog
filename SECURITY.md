# Security Policy

We take the security of Superlog and its users seriously. Thank you for helping
keep Superlog and the people who use it safe.

## Supported Versions

Superlog ships from `main`. Security fixes are applied to the latest release and
the current `main` branch only. Older commits and tags are not patched — please
upgrade to the latest version before reporting an issue.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release / `main` | :white_check_mark: |
| Anything older     | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or our Discord.**

Instead, use either of these private channels:

- **GitHub Private Vulnerability Reporting** (preferred): open a report from the
  [Security tab](https://github.com/superloglabs/superlog/security/advisories/new)
  of this repository. This keeps the discussion private until a fix is released.
- **Email**: send details to **security@superlog.sh**.

Please include as much of the following as you can:

- The type of issue (e.g. injection, authn/authz bypass, SSRF, RCE, data exposure).
- The affected component (`apps/web`, `apps/api`, `apps/proxy`, `apps/worker`,
  `packages/*`) and file paths or commit if known.
- Step-by-step instructions to reproduce, including any required configuration.
- Proof-of-concept or exploit code, if you have it.
- The impact of the issue and how an attacker might exploit it.

This information helps us triage your report more quickly.

## What to Expect

- **Acknowledgement** within 3 business days of your report.
- An **initial assessment** and severity triage within 7 business days.
- We will keep you informed of progress as we work on a fix, and we will let you
  know when the issue is resolved.
- We practice **coordinated disclosure**: we ask that you give us a reasonable
  opportunity to release a fix before any public disclosure. We are happy to
  credit you in the release notes and advisory unless you prefer to remain
  anonymous.

## Security Advisories

After a vulnerability is fixed and disclosed, we publish a security advisory in
the [GitHub Security Advisories](https://github.com/superloglabs/superlog/security/advisories)
section of this repository. You can watch the repository or enable GitHub
notifications to stay informed about new security releases.

## Scope

This policy covers the open-source code in this repository. Issues in the hosted
**Superlog Cloud** service should also be reported through the channels above.

Out of scope (please do not report these):

- Reports from automated scanners without a demonstrated, exploitable impact.
- Denial-of-service achievable only through unrealistic traffic volumes.
- Vulnerabilities in third-party dependencies that are already publicly known —
  open a regular issue or PR to bump the dependency instead.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith,
follow this policy, avoid privacy violations and service degradation, and give
us a reasonable time to remediate before disclosing.
