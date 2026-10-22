# 0002. The employer's ATS is the source of truth; aggregators are discovery only

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Aggregators (LinkedIn, Indeed and boards that copy them) have three problems:

- Their "posted N hours ago" label resets when a listing is refreshed or reposted.
- They keep listings up after the employer closes them.
- They route applications through themselves.

In practice, many "just posted" aggregator jobs turned out to be weeks old at the employer, closed, or bait posts by third parties.

Employer applicant tracking systems (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle, iCIMS) publish jobs through public APIs, with the real first-published date and the live state of each posting.

## Decision

- A job may be shown only if the **employer's system** confirms all three:
  - first posted ≤ 24 h ago (an exact timestamp, or a day-only date equal to today);
  - the posting is open;
  - it has an official URL on the employer's ATS.
- Aggregator results are **leads**. Before they can be shown, they are matched to the employer's posting: same employer, title similarity ≥ 0.8 with the same seniority words, compatible location, and a single best match.
- An aggregator time never upgrades a job to NEW. A fresh listing with an older employer date is POSSIBLE_REPOST.
- An unidentifiable employer is excluded, never guessed.

## Consequences

- High precision: every alert links to a real, open, new posting.
- Lower recall: jobs at employers whose ATS can't be read (custom career sites, login walls) are never shown, even when genuinely new. This is accepted (see [DESIGN.md § Non-goals](../DESIGN.md#3-non-goals)).
- Verification costs extra requests, bounded by the shortlist limit (≤ 15) and the time limits.
