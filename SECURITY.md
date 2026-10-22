# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability** on this repository). You'll get a response within 7 days.

Useful details: affected file/function, steps to reproduce, impact, and a suggested fix if you have one.

## Supported versions

Only the latest release on `main` receives fixes.

## Security model

| Area | Measure |
|---|---|
| Secrets | Read only from environment variables (`.env` locally, GitHub Actions secrets in CI). `.env` is git-ignored. `npm run check:secrets` runs in CI and fails on token-like strings in tracked files. |
| Personal data | `config/` and `state/` are git-ignored in the public template; private instances add them explicitly. |
| Outbound requests | URLs built from external data are validated against the expected ATS host; provider requests refuse private and loopback addresses (SSRF guard). Every request has a timeout. |
| Untrusted content | Job postings are treated as data only. They never control program flow, the AI prompt instructs the model to ignore embedded instructions, and AI output is schema-validated and rendered as escaped text. |
| Email | HTML is built with escaped values only; links come from verified employer URLs. |
| CI | `ci.yml` has read-only permissions. `scan.yml` has `contents: write` only to commit state. Workflow inputs are passed through environment variables, never interpolated into scripts. |
| Agents (MCP) | Paid scans require an explicit opt-in on the server process (`RADAR_MCP_ALLOW_APIFY=1`); the server never sends email or applies to jobs. |

## If a secret leaks

1. Revoke it immediately: the Gmail App Password (myaccount.google.com/apppasswords), the Apify token (console.apify.com → Settings → API), or the Anthropic key (console.anthropic.com → API Keys).
2. Create a new one and update the GitHub secret.
3. Removing the commit is not enough once a secret has been pushed; revocation is what protects you.
