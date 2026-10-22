# 0001. Extract the scan engine from career-ops into a standalone repository

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The fresh-job scanner was built inside a personal copy of [career-ops](https://github.com/santifer/career-ops), an AI job-search toolkit. It worked well (≈ 185 tests, daily use), but it was tied to career-ops' layout, tracker and personal files. Through its provider registry and scan scripts it also imported 77 career-ops modules (≈ 25K lines). Turning it into a scheduled alert service that others could reuse required a clean, standalone codebase.

## Options

1. **Depend on career-ops as a package.** It isn't published as one, and the engine needs internal modules.
2. **Rewrite from scratch.** Throws away tested behavior (freshness rules, Workday matching, repost detection) and invites regressions.
3. **Extract the engine and vendor only what it needs.**

## Decision

Option 3:

- Move `local/discovery` into `src/engine/`.
- Copy only the needed career-ops modules into `src/vendor/`: ATS providers, the HTTP/IP guard, URL keys, fingerprinting, and the title/location filters.
- Replace the parts that only make sense inside career-ops (path resolver, tracker parser, scan scripts) with small local modules: `paths.mjs`, `ats-datasets.mjs`, `scan-filters.mjs`, `text-key.mjs`.
- Make all personal rules configurable through `profile.yml`, with defaults equal to the previous behavior.

## Consequences

- All existing tests pass unchanged against the extracted code, so behavior is preserved.
- `src/vendor/` is about 8.4K lines, a third of the original closure. It is MIT licensed and credited in `LICENSE` and `src/vendor/LICENSE-career-ops`.
- Upstream fixes to career-ops providers don't flow in automatically; they must be copied deliberately.
- The engine can still read a career-ops `scan-history.tsv` and tracker, for people who use both.
