# Troubleshooting

Start with the one-line summary every run prints:

```
[job-radar] scan 34.2s · found 3 · alerting 2 · apify $0.057 · ai $0.0712 · email sent
```

And with the report footer from `npm run scan`:

```
Collected 283 · evaluated 120 · shortlisted 0. Excluded: title filter 5334 · location filter 161 · seen before 98 · …
Board failures: 10 — http 404 ×8, http 500 ×1, timeout ×1. Slowest: …
```

The **Excluded** counts tell you exactly why jobs didn't make it.

## No jobs / "0 verified"

This is the most common question, and it is usually correct behavior: the bar is strict on purpose.

| Excluded reason | Meaning | What to do |
|---|---|---|
| `seen before` | Already reported or seen in an earlier scan | Nothing; this is repost protection working |
| `original freshness unverifiable` | Only an aggregator time, or no date | Nothing; it can't be proven new. Add the company to `tracked_companies` if you want it checked directly |
| `older than 24h` | The employer's date is older | Nothing |
| `possible repost` | Near-identical to a known job | Nothing |
| `title filter` (large number) | Titles didn't match `title_filter.positive` | Normal (most jobs at most companies aren't yours). If good roles are missing, add keywords |
| `location filter` | Location not allowed | Check `location_filter.allow` / `block_hard` |
| `blacklist` | Company or domain is in `config/blacklist.md` | Remove the entry if you changed your mind |
| `already in tracker` | You already track this role (career-ops interop only) | Nothing |
| `eligibility blocked` | A hard disqualifier was found | See the quote in `--json` output; adjust `eligibility` if a rule doesn't apply to you |
| `no live employer page verified` | Couldn't find the posting at the employer | Add the company's board to `tracked_companies` or `companyBoards` |
| `employer hidden` | Agency post with no company name | Nothing (deliberately excluded) |

To see more candidates while testing, check the "Age of evaluated jobs" line. It shows how many jobs were < 6 h, 6–12 h, 12–24 h old and how many of those had an employer date.

## Email

| Symptom | Cause / fix |
|---|---|
| `email not configured (missing GMAIL_USER, …)` | Set the secrets (Actions) or `.env` (local). Run `npm run test-email`. |
| `Invalid login: 535-5.7.8 Username and Password not accepted` | Use an **App Password**, not your account password; 2-Step Verification must be on. Regenerate it if unsure. |
| App Passwords page says "not available" | Workspace account with App Passwords disabled → use a personal Gmail as the sender. |
| Emails land in spam | Mark one as "Not spam" and add the sender to contacts. |
| Run exits with code 2 | The email failed. Jobs are kept in `state/alerts.json → pending` and re-sent next run. |
| No email but `found 3 · alerting 0` | The jobs were below `alerts.email.min_fit`, or VERIFY with `include_verify: false`. |

## GitHub Actions

| Symptom | Cause / fix |
|---|---|
| The workflow never runs | Set the repository **variable** `RADAR_ENABLED=true` (a variable, not a secret). |
| "config/profile.yml and config/portals.yml are missing" | In your private copy: `git add -f config/profile.yml config/portals.yml`, commit, push. |
| "Save state" fails with 403 | Settings → Actions → General → Workflow permissions → **Read and write**. |
| "Could not push state after 3 attempts" | Someone pushed at the same moment; it will catch up next run. If it repeats, pull and push manually. |
| Runs are a few minutes late | GitHub delays scheduled jobs under load. Nothing to fix. |
| Scheduled runs stopped | GitHub disables schedules after 60 days without repository activity. State commits normally prevent this; re-enable under Actions. |
| Apify runs at the wrong local time | Cron is UTC; edit the times in `scan.yml` for your timezone or for winter time. |

## Apify

| Symptom | Cause / fix |
|---|---|
| `Apify skipped: APIFY_TOKEN is not set` | Add the token (Actions secret or `.env`). Free sources still ran. |
| `401` / `403` from Apify | Token revoked or wrong. Create a new one in the Apify console. |
| `apify $0` on a paid run | The cron for paid runs is the `:37` one; manual runs need **Include LinkedIn/Indeed** ticked. |
| Cost warning in the report | Spend passed `warnUsd` ($0.08). The scan cap still holds. |
| Many `employer hidden` | Indeed agency posts; expected. |

## AI notes

| Symptom | Cause / fix |
|---|---|
| `ai skipped (ANTHROPIC_API_KEY not set)` | Add the key, or ignore (alerts work without notes). |
| `ai error (invalid ANTHROPIC_API_KEY …)` | Create a new key at console.anthropic.com. |
| `ai error (rate limited …)` | Temporary; the next alert retries. |
| `ai error (model declined the request)` | Rare; the email went out without notes. |

## Scans

| Symptom | Cause / fix |
|---|---|
| `⚠ Partial result: soft limit` | The scan hit 3 minutes; you get the best found so far. Lower `rotationBatch` or the number of tracked companies if it happens often. |
| Many `http 404` board failures | Boards from the public list that no longer exist. They're skipped after 3 misses. |
| `timeout` on one board every time | That board is slow (e.g. large Workday tenants). Harmless; other boards continue. |
| `unknown preset "x"` | Check spelling, or define it under `discovery.presets` in `profile.yml`. |
| A job you saw on LinkedIn isn't reported | It must be confirmed at the employer and first posted ≤ 24 h ago there. Try the MCP `check_job_link` tool on the employer URL to see its real age. |

## Resetting

| Goal | Command |
|---|---|
| Forget seen jobs (everything current is "new" once) | delete `state/job-seen.json` |
| Re-send nothing that failed | delete `state/alerts.json` |
| Restart the rotation from the beginning | delete `state/discovery-state.json` |
| Clear cached board lists | delete `state/cache/` |

## Still stuck?

Run with full output and open an issue with the summary line, the report footer, and your Node version (never your `.env` or secrets):

```bash
node --version
npm run scan -- --no-apify --dry-run --json > scan.json
```
