# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-22

First standalone release. The scan engine is extracted from a personal career-ops setup, where it was in daily use.

### Added

- **Scan engine** (`src/engine/`): tracked companies, a rotating sample of ~9,000 public ATS boards, and optional LinkedIn/Indeed discovery via Apify, all running through one pipeline: normalize → dedup → first-seen → freshness → filters → eligibility → fit score → employer verification → strict final gate.
- **Profile-driven rules:** roles, skills, preferred locations, salary bands and eligibility (sponsorship, citizenship/clearance, OPT, enrollment, graduation date, years, salary floor, relocation) configured in `config/profile.yml`.
- **Email alerts** (`npm run alert`): Gmail SMTP, HTML + text, minimum fit threshold, an alert ledger that never re-sends, and retries for undelivered alerts.
- **Optional AI notes:** one Claude structured-output request per alert adds a "fit / gap" line per job. It never affects which jobs are sent.
- **MCP server** (`npm run mcp`): `run_scan`, `check_job_link`, `check_eligibility`. Paid scans need an explicit opt-in on the server.
- **GitHub Actions:** an hourly free scan, 3 runs a day with Apify, state committed back, and an inert template until `RADAR_ENABLED=true`. CI runs on Node 20/22/24 with a secret scan.
- **Dead-board tracking:** rotation boards returning HTTP 404 three times are skipped for 30 days.
- **Documentation:** README, architecture, design, guardrails, configuration, deployment, sources, cost, troubleshooting, five ADRs, contributing and security policies.

### Fixed

- One posting reached through two sources with different location text no longer appears twice in the results.
