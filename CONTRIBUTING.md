# Contributing

Thanks for helping. job-radar is small on purpose. Contributions that keep it **correct, bounded and cheap** are the most welcome.

## Ground rules

1. **Precision first.** A change must never let a job through that fails the strict final gate (see [docs/GUARDRAILS.md](docs/GUARDRAILS.md)). New sources are discovery-only unless they read the employer's own system.
2. **No LLM in the scan pipeline** ([ADR 0003](docs/adr/0003-llm-only-for-judgment.md)).
3. **Limits stay in `LIMITS`.** Don't add a setting that can raise a time, cost or concurrency limit.
4. **No secrets, no personal data** in code, tests, fixtures or issues.
5. **Respect sites.** Use public APIs, identify job-radar in the User-Agent, and don't add sources that require a login or prohibit automated access.

## Development setup

```bash
git clone https://github.com/Yogananda16/job-radar.git
cd job-radar
npm install
npm test                 # ~200 tests, offline, < 10 s
npm run check            # secret scan + tests (what CI runs)
```

Node.js 20 or newer. No build step: plain ES modules (`.mjs`).

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Create a branch: `git checkout -b feat/short-name`.
3. Write or update tests in `tests/`. Every rule change (freshness, eligibility, matching, limits) needs a test that would fail without it. Tests must not touch the network: use `mockFetch` / injected clients (see `tests/helpers.mjs`).
4. Update the docs when behavior or configuration changes (`docs/CONFIGURATION.md` for new options; a new ADR for a significant decision).
5. Run `npm run check`.
6. Open a pull request describing **what** changed and **why**, and how you tested it.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add SmartRecruiters company boards
fix: treat Workday day-only dates in the user's timezone
docs: explain location_filter evaluation order
test: cover iCIMS hiringOrganization mismatch
```

## Code style

- Match the surrounding code: small pure functions, early returns, comments that explain *why*.
- Engine code never writes to stdout (the MCP server uses it). Use the returned result, or `console.error` for diagnostics.
- Every network call goes through the bounded HTTP helpers and respects the scan's abort signal.
- Code in `src/vendor/` comes from career-ops. Keep changes there minimal and note them in the file header.

## Adding a provider or source

See [docs/ARCHITECTURE.md § Extending](docs/ARCHITECTURE.md#9-extending-job-radar).

## Reporting bugs

Include the run's summary line, the report footer (`Collected … Excluded …`), your Node version and OS. **Never** include `.env`, tokens, or your `profile.yml` if it contains personal details.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
