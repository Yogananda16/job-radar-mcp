# Cost

job-radar is designed to cost nothing by default and a few dollars a month with every option on. All paid parts are optional and capped.

## Summary

| Component | Price basis | Cap | Typical monthly cost |
|---|---|---|---|
| Employer ATS APIs + free boards | free | — | **$0** |
| GitHub Actions (private repo) | 2,000 free minutes/month | 10 min per run | **$0** (~900 min used) |
| Gmail | free | — | **$0** |
| Apify (LinkedIn/Indeed) | per run + per result | $0.10/scan default, $0.25 max | **≈ $5** at 3 scans/day |
| Claude API (AI notes) | per token | 1 request per alert, ≤ 10 jobs | **≈ $0.06** (Haiku, 1 alert/day) **to ≈ $17** (Opus, 8 alerts/day) |

## Apify

Pricing as observed on the two actors (pay-per-event):

| Actor | Per run start | Per result |
|---|---|---|
| LinkedIn (`valig/linkedin-jobs-scraper`) | $0.001 | ~$0.0004 |
| Indeed (`valig/indeed-jobs-scraper`) | $0.001 | ~$0.0001 |

**One scan with the default settings** (6 queries, each run on both actors = 12 runs, 15 results per run):

```
runs:      12 × $0.001                        = $0.012
LinkedIn:   6 × 15 × $0.0004                  = $0.036
Indeed:     6 × 15 × $0.0001                  = $0.009
                                         total ≈ $0.057   (cap: $0.10)
```

Real scans are often cheaper, because fewer than 15 results come back for narrow queries.

| Schedule | Scans/month | Monthly |
|---|---|---|
| 3×/day (default) | 90 | ≈ $5 (max $9 at the cap) |
| 1×/day | 30 | ≈ $1.70 |
| Hourly | 720 | ≈ $41 (max $72) |

**How the cap works:**

- Before each Apify run, the cost ledger reserves that run's maximum (`perRunCapUsd`). A run that would exceed `scanCapUsd` isn't started.
- Each run is sent with `maxTotalChargeUsd`, so Apify itself stops at the cap.
- After the run, the exact charge is read back from `chargedEventCounts`.

Apify's free plan includes monthly platform credit, which may cover light use.

## Claude API (optional AI notes)

One request per alert email, containing up to 10 jobs (≤ 6,000 characters of job text each) plus your profile.

| Model | Input / output per 1M tokens | Typical alert (≈ 15K in, 600 out) |
|---|---|---|
| `claude-opus-5-5` (default) | $4 / $20 | ≈ $0.07 |
| `claude-sonnet-5-5` | $2 / $10 | ≈ $0.04 |
| `claude-haiku-5-5` | $0.10 / $0.50 | ≈ $0.002 |

Monthly cost depends on how often there's something to send (an email only goes out when new jobs pass your filters):

| Alerts/day | Opus | Haiku |
|---|---|---|
| 1 | ≈ $2.10 | ≈ $0.06 |
| 3 | ≈ $6.30 | ≈ $0.18 |
| 8 | ≈ $17 | ≈ $0.48 |

The profile block is marked for prompt caching, but it's usually below the minimum cacheable length, so expect little cache saving. The exact cost of each request is computed from the returned token usage and shown in the email footer.

## GitHub Actions

A free scan takes 30–60 seconds; with Apify, 1–2 minutes. Billing rounds each job up to the minute, plus about 30 seconds of setup:

```
hourly:  24 × 30 days × ~1 min  ≈ 720 min
Apify:    3 × 30 days × ~2 min  ≈ 180 min   (extra runs at :37)
                                ≈ 900 min of 2,000 free
```

Public repositories have unlimited free minutes.

## Lowering cost

| Lever | Saving |
|---|---|
| Remove `APIFY_TOKEN` | All Apify spend; employer boards still scanned hourly |
| Fewer Apify queries (`discovery.apify.queries`) | ~$0.008 per query per scan |
| Lower `limitPerQuery` (e.g. 10) | Proportional to results |
| Paid scans 1×/day (edit the second cron in `scan.yml`) | ~65% of Apify |
| `ai.model: claude-haiku-5-5` | ~97% of AI cost |
| Raise `alerts.email.min_fit` | Fewer alerts → fewer AI calls |
