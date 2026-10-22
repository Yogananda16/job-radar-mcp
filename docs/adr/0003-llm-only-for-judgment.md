# 0003. No LLM in the scan pipeline; an optional LLM only for post-decision notes

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

An LLM could classify job titles, read eligibility wording, or rank jobs. But the scan runs 24 times a day over thousands of postings, and its outputs are facts that must be right: is this job new, is it open, does it exclude visa holders?

## Decision

- The scan pipeline is **deterministic**: regex rules with quoted evidence, fixed scoring weights, explicit thresholds. Same input, same output.
- An LLM is used only **after** the decision, on the final shortlist (≤ 10 jobs), for a judgment task rather than a factual one: a one-line "why you fit" and "main gap" per job. It runs once per alert email and returns schema-validated structured output.
- The AI layer can't add, remove or reorder jobs. On any failure (missing key, error, refusal, malformed output), the email goes out without notes.

## Consequences

- **Cost:** scanning is free; AI notes cost cents per alert and are optional.
- **Testability:** about 200 offline unit tests pin every rule, with no model calls in tests.
- **Explainability:** every exclusion has a reason and, for eligibility, the exact sentence that triggered it.
- **Trade-off:** regex rules miss unusual phrasing. Mitigations: VERIFY for ambiguous wording, a test for each false positive or negative found, and a planned labelled eval set to measure precision and recall.
