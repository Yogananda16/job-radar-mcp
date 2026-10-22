# Architecture Decision Records

Short records of significant decisions: the context, the choice, and its consequences. They follow [Michael Nygard's ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions). A record is never rewritten; a later decision supersedes it with a new record.

| # | Decision | Status |
|---|---|---|
| [0001](0001-extract-engine-from-career-ops.md) | Extract the scan engine from career-ops into a standalone repository | Accepted |
| [0002](0002-employer-ats-as-source-of-truth.md) | The employer's ATS is the source of truth; aggregators are discovery only | Accepted |
| [0003](0003-llm-only-for-judgment.md) | No LLM in the scan pipeline; an optional LLM only for post-decision notes | Accepted |
| [0004](0004-github-actions-with-committed-state.md) | Run on GitHub Actions and commit state to a private repository | Accepted |
| [0005](0005-email-first-alerts.md) | Email (Gmail SMTP) as the first alert channel | Accepted |

To add a record, copy the newest one, increment the number, and add a row here.
