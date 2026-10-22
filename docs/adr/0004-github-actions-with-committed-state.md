# 0004. Run on GitHub Actions and commit state to a private repository

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Alerts must run hourly whether or not the user's computer is on. Each run needs memory from previous runs:

- the first-seen store (no repeats);
- the rotation cursor;
- the dead-board list;
- undelivered alerts.

The code should be shareable, while each user's profile and history stay private.

## Options

| Option | Runs with PC off | Durable state | Cost | Setup |
|---|---|---|---|---|
| Windows Task Scheduler / cron | no | local disk | free | low |
| GitHub Actions + Actions cache for state | yes | **no**: the cache evicts after 7 days unused and is best effort | free | low |
| GitHub Actions + state committed to the repo | yes | yes, versioned | free | low |
| Cloud function + database | yes | yes | small but non-zero | high |

## Decision

- A scheduled **GitHub Actions** workflow runs free scans hourly, plus 3 runs a day with paid discovery.
- **State is committed back** to the repository after each run (`git add -f state/...`, then pull-rebase-push with retries). Runs never overlap (`concurrency` group).
- **Two repositories:**
  - a public template: code and docs, personal files git-ignored, and the workflow inert until `RADAR_ENABLED=true`;
  - a private instance per user, with config and state force-added.
- Rebuildable caches (public board lists) use the Actions cache, not git.
- Local scheduling stays documented as an alternative.

## Consequences

- Free for a private repository (≈ 900 of 2,000 monthly minutes), and unlimited for public ones.
- State history is auditable: one small commit per run that changed something.
- The regular commits keep GitHub from disabling the schedule for inactivity.
- The private repository gets commit noise; this is accepted, and it doesn't affect the template.
- Scheduled runs can start a few minutes late when GitHub is busy.
