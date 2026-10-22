# 0005. Email (Gmail SMTP) as the first alert channel

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Alerts could go by email, WhatsApp, SMS or push notification. The channel had to be:

- free or nearly free;
- reliable;
- able to show a table of jobs with links;
- usable without a new paid account;
- easy for other users to set up.

| Channel | Cost | Setup | Rich content | Notes |
|---|---|---|---|---|
| Gmail SMTP + App Password | free | App Password | HTML table | Reliable; needs 2-Step Verification |
| SendGrid / SES | free tier | account + domain verification | HTML | More setup than a personal tool needs |
| WhatsApp via Twilio | ~$0.005/msg | account + sandbox or business approval | limited | Official, but more setup |
| WhatsApp via CallMeBot | free | message a bot | text only | Unofficial |
| Push (ntfy) | free | app + topic | short text | Topic names are public unless self-hosted |

## Decision

Email through Gmail SMTP (`nodemailer`, port 465), with the App Password read from environment variables. Each message is HTML with a plain-text alternative. The notifier interface (`send(message) → { sent, skipped? }`) leaves room for other channels later.

## Consequences

- Zero cost, and most users already have Gmail.
- Delivery failures are handled by the alert ledger: undelivered jobs become pending and are retried, and the run exits with code 2 so the failure is visible.
- Google Workspace accounts may have App Passwords disabled. The workaround is a personal sender address, with `ALERT_TO` set to any recipient.
- WhatsApp and push stay on the roadmap ([DESIGN.md § Future work](../DESIGN.md#8-future-work)).
