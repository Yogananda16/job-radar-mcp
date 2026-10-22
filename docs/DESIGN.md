# Design

| | |
|---|---|
| **Status** | Implemented (v0.1) |
| **Author** | Yogananda Manjunath |
| **Last updated** | 2026-10-22 |

## 1. Problem

Early applications get more attention, so job seekers watch boards constantly. But the "posted 2 hours ago" label on aggregators (LinkedIn, Indeed, and the boards that copy them) is unreliable:

- **Refreshes look new.** Boards re-list old jobs, and recruiters repost them. The displayed age resets; the job does not.
- **Dead jobs stay up.** Aggregators keep listings online after the employer closes the requisition.
- **Links go the long way round.** Apply buttons often lead through the aggregator, or to a stale copy.
- **Eligibility is buried.** Lines like "no sponsorship now or in the future" or "US citizens only" sit deep in the text, and each one costs a candidate who needs a visa a wasted application.

Checking everything by hand every hour is not realistic.

## 2. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Show only jobs **genuinely first posted ≤ 24 h ago** | Every shown job has an employer-side publish date ≤ 24 h, or an employer day-only date equal to today |
| G2 | **Never show a job twice**, including refreshes and reposts | Every shown job is absent from the first-seen store before the run |
| G3 | **Every link works and is official** | Every shown job was live on the employer's ATS during the scan, and its apply URL is on that ATS |
| G4 | **Respect eligibility** | Every hard disqualifier from the profile is BLOCKED with a quote; ambiguous wording is VERIFY |
| G5 | **Cheap** | $0 for hourly free scans; ≤ $0.10 per scan with paid discovery; ≈ $5/month at 3 paid scans a day |
| G6 | **Bounded** | Every scan finishes within 5 minutes; nothing runs after the process exits |
| G7 | **Hands-off** | Runs on a schedule with the user's computer off; emails only when there is something new |
| G8 | **Reusable** | Anyone can configure it for their own profile without code changes |

## 3. Non-goals

- **Applying.** job-radar never submits an application or fills a form.
- **Maximum coverage.** Precision beats recall. A missed job is acceptable; a fake "new" job is not.
- **Scraping behind logins**, or sites whose terms prohibit automated access.
- **Ranking with an LLM.** The model never decides what is shown (see [ADR 0003](adr/0003-llm-only-for-judgment.md)).
- **A web UI.** Email, Markdown/JSON and MCP are the interfaces for v0.1.
- **Non-US markets** in the default configuration (the location filter is configurable).

## 4. Requirements

### Functional

| ID | Requirement |
|---|---|
| F1 | Collect jobs from tracked company boards, a rotating sample of public ATS boards, and optionally LinkedIn/Indeed |
| F2 | Normalize all sources to one job shape and merge duplicates across sources |
| F3 | Persist a first-seen record per job under several identity keys, kept 180 days |
| F4 | Classify each job as NEW / SEEN / POSSIBLE_REPOST / VERIFY / STALE from employer evidence |
| F5 | Apply hard filters (title, location, blacklist, preset) and the eligibility gate from the profile |
| F6 | Score fit 0–5 deterministically |
| F7 | Verify shortlisted jobs at the employer: live, publish date, official URL |
| F8 | Return at most 10 jobs, never padded with jobs that fail the gate |
| F9 | Email new jobs above a fit threshold; never email the same job twice; retry undelivered alerts |
| F10 | Optionally annotate emailed jobs with an AI fit/gap note |
| F11 | Expose scan, link check and eligibility check over MCP |
| F12 | Report why jobs were excluded (counts by reason) and which boards failed |

### Non-functional

| ID | Requirement |
|---|---|
| N1 | Hard time limit 5 min per scan; soft limit 3 min (no new work); sources stop at 90 s |
| N2 | ≤ 3 parallel source workers; ≤ 8 concurrent HTTP requests; 8 s per request |
| N3 | Paid spend capped per scan in code and enforced by Apify (`maxTotalChargeUsd`) |
| N4 | No secrets in the repository; secrets only from environment / GitHub secrets |
| N5 | Personal data (profile, state) never in the public template |
| N6 | Every rule covered by offline unit tests; CI on Node 20/22/24 |
| N7 | Any optional dependency (Apify, Claude, Gmail) can fail without crashing the run |

## 5. Approach

### 5.1 Ask the employer, not the board

Employer applicant tracking systems publish their jobs through public JSON APIs, and most include a real first-published timestamp (Greenhouse `first_published`, Lever `createdAt`, Ashby `publishedAt`, SmartRecruiters `releasedDate`). These are the source of truth for freshness (G1) and liveness (G3). Aggregators are useful only for **discovery**: finding jobs at employers we don't track. A job found on LinkedIn reaches the results only after the same job is found and confirmed on the employer's system ([ADR 0002](adr/0002-employer-ats-as-source-of-truth.md)).

### 5.2 Remember everything

Freshness from timestamps alone isn't enough: employers also repost. The first-seen store keys each job by source id, canonical URL, requisition number, company+title+location, and a text fingerprint. Any match means SEEN (or POSSIBLE_REPOST for a ≥ 0.92 fingerprint match). The store is committed back to the repository after each scheduled run, so memory survives stateless CI runners ([ADR 0004](adr/0004-github-actions-with-committed-state.md)).

### 5.3 Deterministic core, optional AI edge

Everything that decides *what you see* is deterministic code: regexes with quoted evidence, fixed weights, explicit thresholds. That makes it testable (≈ 200 offline tests), explainable ("BLOCKED: 'We will not sponsor… now or in the future'"), free to run 24 times a day, and immune to hallucination. The LLM is used once per alert, after the decision, for a judgment task that suits it: phrasing a fit/gap note ([ADR 0003](adr/0003-llm-only-for-judgment.md)).

### 5.4 Precision over recall

When evidence is missing or ambiguous, the job is excluded, and the exclusion is counted and explained. The Top 10 is never padded. Concretely:

- an aggregator time never upgrades a job to NEW;
- a calendar date of *yesterday* without a time is excluded;
- two equally plausible employer postings for one aggregator job means "ambiguous → reject".

### 5.5 Bounded by construction

Limits live in one frozen `LIMITS` object and are applied by `applyLimits()` *after* user config and presets are merged. So no configuration can raise a limit, only lower it ([GUARDRAILS.md](GUARDRAILS.md)).

## 6. Key decisions

| Decision | Alternatives considered | Why | ADR |
|---|---|---|---|
| Extract the engine into its own repo, vendoring only the provider modules it needs | Depend on career-ops as a package; full rewrite | Keeps proven, tested code; career-ops is MIT; vendors about a third of the original import closure (8.4K of 25K lines) | [0001](adr/0001-extract-engine-from-career-ops.md) |
| Employer ATS = source of truth; aggregators = discovery only | Trust aggregator dates; scrape career pages | Only the employer knows the real publish date and whether the job is open | [0002](adr/0002-employer-ats-as-source-of-truth.md) |
| No LLM in the scan; optional LLM notes after | LLM ranking/filtering | Cost, determinism, testability, no hallucinated facts | [0003](adr/0003-llm-only-for-judgment.md) |
| GitHub Actions + state committed to the repo | Local Task Scheduler; a database; Actions cache for state | Free, runs with the PC off, auditable history; cache evicts and isn't durable | [0004](adr/0004-github-actions-with-committed-state.md) |
| Gmail SMTP with App Password | SendGrid/SES; WhatsApp (Twilio/CallMeBot); push (ntfy) | Free, no new account, reliable; other channels can be added behind the same interface | [0005](adr/0005-email-first-alerts.md) |
| Public template + private instance | One private repo; one public repo | Shareable code with zero personal data; users keep their profile and history private | [0004](adr/0004-github-actions-with-committed-state.md) |

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| An ATS changes its API shape | Source returns nothing | Per-board failure reporting; providers are isolated modules; tests pin observed shapes |
| Public board lists go stale | Rotation hits dead boards | Dead-board skip list (3+ misses, recheck after 30 days); failures counted |
| Apify price or actor changes | Higher cost | Server-side `maxTotalChargeUsd`; exact cost read back from charged events; per-scan cap ≤ $0.25 in code |
| GitHub disables idle schedules (60 days) | Alerts stop silently | State commits count as activity; GitHub emails the owner on workflow failure |
| Gmail outage / bad password | Missed alert | Undelivered rows kept as pending and retried; run exits 2 so the failure is visible |
| False BLOCKED from boilerplate (e.g. "Employee Polygraph Protection Act") | Good job hidden | Rules use negative lookaheads for known boilerplate; regression tests per case |
| Personal data pushed to the public repo | Privacy | `.gitignore` for config/state; secret scan in CI; private instance uses `git add -f` explicitly |

## 8. Future work

- More alert channels (WhatsApp via Twilio, push via ntfy) behind the notifier interface.
- A small labelled eval set (~50 postings) to measure eligibility-gate precision and recall.
- A read-only web dashboard calling `runFreshScan()` / `tools.mjs`.
- Per-company scan frequency (hot companies every hour, long tail daily).
