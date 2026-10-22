// Presets: run · faang · staffing · startup · remote · local · company <name>.
// All are configuration for the one runFreshScan() pipeline. Mocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseCommand, resolvePreset, DEFAULT_PRESETS } from '../src/engine/presets.mjs';
import { parseCli } from '../src/engine/cli.mjs';
import { loadConfigForPreset, LIMITS } from '../src/engine/config.mjs';
import { buildPresetFilter, buildLocalMatcher, isUsRemote, inCompanyFamily } from '../src/engine/filters.mjs';
import { resolveCompanyBoards, confirmWorkdayTenant } from '../src/engine/sources/company-boards.mjs';
import { trackedBoards } from '../src/engine/sources/tracked.mjs';
import rotationSource, { loadState } from '../src/engine/sources/ats-rotation.mjs';
import { buildWorkdayIndex } from '../src/engine/workday-verify.mjs';
import { linkedinAdapter } from '../src/engine/sources/apify-linkedin.mjs';
import { runFreshScan } from '../src/engine/run.mjs';
import { renderMarkdown } from '../src/engine/report.mjs';
import { loadProviders } from '../src/vendor/providers/_registry.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { NOW, HOUR, tmpDir, testConfig, deps, freshStore, mockFetch, atsJob, GOOD_JD } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ALL = ['run', 'faang', 'staffing', 'startup', 'remote', 'local', 'company Amazon'];

// ── Command parsing ──────────────────────────────────────────────────

test('commands: what the user types → preset + arg', () => {
  assert.deepEqual(parseCommand('faang'), { name: 'faang', arg: '' });
  assert.deepEqual(parseCommand('company Capital One'), { name: 'company', arg: 'Capital One' });
  assert.deepEqual(parseCommand(''), { name: 'run', arg: '' });
  const c = parseCli(['company', 'Capital', 'One', '--dry-run', '--no-apify'], { pid: 1, tmpdir: '/tmp' });
  assert.equal(c.command, 'company Capital One');
  assert.equal(c.dryRun, true);
  assert.deepEqual(c.overrides.sources, { apify: false });
  assert.equal(parseCli([]).command, 'run');
  assert.deepEqual(parseCli(['--bogus']).unknown, ['--bogus']);
});

test('unknown preset or a bare "company" → clear error', () => {
  assert.throws(() => resolvePreset('fangg'), /unknown preset "fangg"/);
  assert.throws(() => resolvePreset('company'), /usage: company <name>/);
});

// ── Mapping to scan options ──────────────────────────────────────────

test('mapping: each preset → sources + filters', () => {
  const m = Object.fromEntries(ALL.map((c) => [c, resolvePreset(c)]));
  assert.deepEqual(m.run.filters, {});
  assert.deepEqual(m.faang.filters.companies, ['Meta', 'Google', 'Amazon', 'Apple', 'NVIDIA', 'Microsoft']);
  assert.deepEqual(m.faang.overrides.sources, { tracked: false, 'ats-rotation': false, apify: true, 'company-boards': true });
  assert.equal(m.faang.overrides.apify.actors.indeed.enabled, false);
  assert.deepEqual(m.staffing.filters.companies, ['Experis']);
  assert.deepEqual(m.startup.overrides.rotationAts, ['ashby', 'lever']);
  assert.equal(m.startup.overrides.trackedCategory, 'startup');
  assert.equal(m.startup.overrides.sources.apify, false);
  assert.deepEqual(m.remote.filters, { location: 'remote' });
  assert.deepEqual(m.local.filters, { location: 'local', locations: ['Connecticut', 'New York', 'New Jersey', 'Massachusetts'], includeRemote: true });
  assert.deepEqual(m['company Amazon'].filters, { companies: ['Amazon'] });
});

test('every preset keeps every guardrail (LIMITS clamp applies after the preset)', () => {
  const dir = tmpDir();
  for (const c of ALL) {
    const cfg = loadConfigForPreset(c, {}, { root: dir });
    assert.ok(cfg.softMs <= LIMITS.softMs && cfg.hardMs <= LIMITS.hardMs, c);
    assert.ok(cfg.apify.scanCapUsd <= LIMITS.maxScanCapUsd, c);
    assert.ok(cfg.topN <= 10 && cfg.shortlistMax <= 15 && cfg.jdFetchMax <= 25, c);
    assert.ok(Object.values(cfg.sources).filter(Boolean).length <= LIMITS.maxWorkers, c);
  }
});

test('profile.yml can add presets/companies — and still cannot loosen a guardrail', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config/profile.yml'), [
    'discovery:',
    '  presets:',
    '    faang: { companies: [Meta, Google, Amazon, Apple, NVIDIA, Microsoft, OpenAI] }',
    '    banks: { companies: [Capital One, JPMorganChase], overrides: { softMs: 999999, apify: { scanCapUsd: 5 } } }',
    '  companyBoards:',
    '    Capital One: [{ careers_url: "https://capitalone.wd12.myworkdayjobs.com/Capital_One" }]',
  ].join('\n'));
  const f = loadConfigForPreset('faang', {}, { root: dir });
  assert.ok(f.filters.companies.includes('OpenAI'));
  const b = loadConfigForPreset('banks', {}, { root: dir });
  assert.deepEqual(b.filters.companies, ['Capital One', 'JPMorganChase']);
  assert.equal(b.softMs, LIMITS.softMs, 'clamped');
  assert.equal(b.apify.scanCapUsd, LIMITS.maxScanCapUsd, 'clamped');
  assert.ok(b.companyBoards['Capital One'] && b.companyBoards.Amazon, 'configured boards merged with defaults');
  assert.equal(loadConfigForPreset('faang', { sources: { apify: false } }, { root: dir }).sources.apify, false, 'CLI flags win');
});

// ── Filters ──────────────────────────────────────────────────────────

test('company filter: the company and its divisions, never look-alikes', () => {
  assert.ok(inCompanyFamily('Amazon', 'Amazon Web Services (AWS)'));
  assert.ok(inCompanyFamily('JPMorganChase', 'JPMorgan Chase & Co.'));
  assert.ok(inCompanyFamily('Capital One', 'Capital One'));
  assert.ok(!inCompanyFamily('Apple', "Applebee's"));
  assert.ok(!inCompanyFamily('Meta', 'Metabase'));
  assert.ok(!inCompanyFamily('Capital One', 'Capital Group'));
});

test('remote filter: US remote only', () => {
  const j = (location, remote = false) => ({ location, remote });
  for (const loc of ['Remote', 'Remote - US', 'United States (Remote)', 'Anywhere in the US']) assert.ok(isUsRemote(j(loc)), loc);
  assert.ok(isUsRemote(j('New York, NY', true)));
  assert.ok(!isUsRemote(j('Remote, Canada')));
  assert.ok(!isUsRemote(j('New York, NY')));
});

test('local filter: CT / NY / NJ / MA (names, abbreviations, cities) + US-remote', () => {
  const local = buildLocalMatcher(DEFAULT_PRESETS.local.locations);
  for (const loc of ['Hartford, CT', 'Stamford, Connecticut', 'New York, NY', 'NYC', 'Jersey City, NJ', 'Princeton', 'Boston, MA', 'Cambridge, Massachusetts', 'US-CT']) assert.ok(local(loc), loc);
  for (const loc of ['Austin, TX', 'Portland, ME', 'Washington, DC', 'CTO Office, Austin']) assert.ok(!local(loc), loc);
  const f = buildPresetFilter(resolvePreset('local').filters);
  assert.equal(f({ company: 'X', location: 'Remote' }), null, 'US-remote still qualifies');
  assert.equal(f({ company: 'X', location: 'Denver, CO' }), 'outside local area');
});

// ── Company boards (official sources) ────────────────────────────────

const fjOf = (routes) => { const f = mockFetch(routes); return async (u, o) => { try { const r = await f(u, o); return r.ok ? r.json() : null; } catch { return null; } }; };

test('company boards: configured (Amazon), tracked, Greenhouse (name-checked), Workday (employer-checked); else unresolved', async () => {
  const providers = await loadProviders(path.join(ROOT, 'src/vendor/providers'));
  const dir = tmpDir();
  const config = testConfig(dir);
  config.companyBoards = loadConfigForPreset('run', {}, { root: dir }).companyBoards;
  const index = buildWorkdayIndex(['nvidia|wd5|nvidiaexternalcareersite', 'google|wd5|gocjobs']);
  const fetchJson = fjOf([
    [/boards-api\.greenhouse\.io\/v1\/boards\/capitalone$/, () => ({ name: 'Capital One' })],
    [/boards-api\.greenhouse\.io\/v1\/boards\/meta$/, () => ({ name: 'Meta Materials Inc' })],
    [/nvidia\.wd5.*\/jobs$/, () => ({ jobPostings: [{ title: 'Engineer', externalPath: '/job/US/Engineer_JR1' }] })],
    [/nvidia\.wd5.*\/job\//, () => ({ jobPostingInfo: { title: 'Engineer' }, hiringOrganization: { name: 'NVIDIA' } })],
    [/google\.wd5.*\/jobs$/, () => ({ jobPostings: [{ title: 'Analyst', externalPath: '/job/US/Analyst_1' }] })],
    [/google\.wd5.*\/job\//, () => ({ jobPostingInfo: { title: 'Analyst' }, hiringOrganization: { name: 'Google Operations Center' } })],
    [/.*/, () => ({ __status: 404 })],
  ]);
  const portals = { tracked_companies: [{ name: 'Hooli Inc.', careers_url: 'https://job-boards.greenhouse.io/hooli' }] };
  const { boards, unresolved } = await resolveCompanyBoards(['Amazon', 'Hooli', 'Capital One', 'NVIDIA', 'Google', 'Meta'], { portals, providers, config, fetchJson, workdayIndex: index });
  const via = Object.fromEntries(boards.map((b) => [b.entry.name, b.via]));
  assert.equal(via.Amazon, 'configured');
  assert.equal(boards.filter((b) => b.entry.name === 'Amazon').length, 3);
  assert.equal(via.Hooli, 'tracked');
  assert.match(via['Capital One'], /greenhouse \(board name confirmed\)/);
  assert.match(via.NVIDIA, /workday \(employer confirmed\)/);
  assert.deepEqual(unresolved.sort(), ['Google', 'Meta'], 'GOC tenant and "Meta Materials" board are NOT treated as Google/Meta');
});

test('company boards: Workday tenant without an employer name is never scanned', async () => {
  const index = buildWorkdayIndex(['acme|wd1|careers']);
  const fetchJson = fjOf([
    [/\/jobs$/, () => ({ jobPostings: [{ title: 'X', externalPath: '/job/US/X_1' }] })],
    [/\/job\//, () => ({ jobPostingInfo: { title: 'X' } })],
  ]);
  assert.deepEqual(await confirmWorkdayTenant('Acme', index, fetchJson), []);
});

test('regression: a company preset (tracked off) still loads provider modules for company-boards', async () => {
  // Real loadDeps path: no injected providers. The 2026-10-13 faang run crashed
  // with "Cannot read properties of undefined (reading 'get')".
  const dir = tmpDir();
  const base = loadConfigForPreset('company Amazon', { sources: { apify: false } }, { root: dir });
  const config = Object.assign(testConfig(dir), { sources: base.sources, filters: base.filters, preset: base.preset, companyBoards: base.companyBoards });
  config.paths.root = ROOT; // real providers/ directory
  const d = deps(freshStore(dir), undefined);
  delete d.providers; delete d.sources;
  d.workdayIndex = null;
  const r = await runFreshScan({ config, now: NOW, persist: false, write: false,
    fetchImpl: mockFetch([[/.*/, () => ({ __status: 404 })]]),
    deps: { ...d, httpCtx: { fetchJson: async () => ({ hits: 0, jobs: [] }), fetchText: async () => '', fetchResponse: async () => ({ ok: true, json: async () => ({ jobs: [] }) }), normalizePostingUrl: (u) => u } } });
  const cb = r.sources['company-boards'];
  assert.ok(!cb.error, `company-boards crashed: ${cb.error}`);
  assert.equal(cb.boards.length, 3, 'Amazon configured boards resolved with the amazon provider');
});

// ── Startup ──────────────────────────────────────────────────────────

test('startup: tracked entries filtered by category; rotation uses Ashby+Lever with its own cursor', async () => {
  const providers = new Map([['greenhouse', { id: 'greenhouse', detect: () => true }]]);
  const { boards } = trackedBoards({ tracked_companies: [
    { name: 'A', careers_url: 'https://x/a', category: 'startup' },
    { name: 'B', careers_url: 'https://x/b', categories: ['ai', 'startup'] },
    { name: 'C', careers_url: 'https://x/c' },
  ] }, providers, { category: 'startup' });
  assert.deepEqual(boards.map((b) => b.entry.name), ['A', 'B']);

  const dir = tmpDir();
  const config = testConfig(dir);
  Object.assign(config, { rotationAts: ['ashby', 'lever'], rotationBatch: 2 });
  const httpCtx = { fetchJson: async (u) => (/lever/.test(u) ? [] : { jobs: [] }), fetchText: async () => '', fetchResponse: async () => ({ ok: true, json: async () => ({}) }), normalizePostingUrl: (u) => u };
  const r = await rotationSource.run({ config, portals: { tracked_companies: [] }, now: NOW, signal: new AbortController().signal, emit: () => {}, prefilter: () => true,
    httpCtx, deadBoards: new Map(), fetchJson: async () => null, rotationLists: { greenhouse: ['gh1'], lever: ['l1', 'l2'], ashby: ['a1'] } });
  assert.deepEqual(r.ats, ['ashby', 'lever']);
  const state = loadState(config.stateFile);
  assert.ok(state['rotation:ashby+lever'] && !state.rotation, 'separate cursor; the normal rotation is untouched');
});

test('location preset with Apify inputs: CT-only filter + LinkedIn/Indeed searched in Connecticut', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config/profile.yml'), [
    'discovery:', '  presets:', '    ct:', '      locations: [Connecticut]', '      includeRemote: false', '      overrides:', '        apify:', '          actors:',
    '            linkedin: { input: { location: "Connecticut, United States" } }',
    '            indeed: { input: { country: us, datePosted: "1", location: "Connecticut" } }',
  ].join('\n'));
  const cfg = loadConfigForPreset('ct', {}, { root: dir });
  assert.deepEqual(cfg.filters, { location: 'local', locations: ['Connecticut'], includeRemote: false });
  const { indeedAdapter } = await import('../src/engine/sources/apify-indeed.mjs');
  assert.equal(linkedinAdapter.buildInput('AI Engineer', { limit: 15, ...cfg.apify.actors.linkedin.input }).location, 'Connecticut, United States');
  assert.deepEqual(indeedAdapter.buildInput('AI Engineer', { limit: 15, ...cfg.apify.actors.indeed.input }), { country: 'us', title: 'AI Engineer', limit: 15, datePosted: '1', location: 'Connecticut' });
  const f = buildPresetFilter(cfg.filters);
  assert.equal(f({ company: 'X', location: 'Stamford, CT' }), null);
  assert.equal(f({ company: 'X', location: 'Remote' }), 'outside local area', 'no remote in ct');
  assert.equal(f({ company: 'X', location: 'New York, NY' }), 'outside local area');
  assert.ok(cfg.apify.scanCapUsd <= 0.10 && cfg.hardMs <= 300_000, 'guardrails unchanged');
});

// ── LinkedIn discovery hints ─────────────────────────────────────────

test('company presets restrict LinkedIn to those employers (companyName) and turn Indeed off', () => {
  const dir = tmpDir();
  const cfg = loadConfigForPreset('faang', {}, { root: dir });
  assert.deepEqual(cfg.apify.companyNames, ['Meta', 'Google', 'Amazon', 'Apple', 'NVIDIA', 'Microsoft']);
  assert.equal(cfg.apify.actors.indeed.enabled, false);
  assert.deepEqual(linkedinAdapter.buildInput('Data Scientist', { limit: 15, companyNames: cfg.apify.companyNames }).companyName, cfg.apify.companyNames);
  assert.deepEqual(loadConfigForPreset('run', {}, { root: dir }).apify.companyNames, []);
});

// ── End to end through the shared pipeline ───────────────────────────

const src = (jobs) => ({ id: 'src', async run(ctx) { ctx.emit(jobs); return {}; } });
const scanPreset = (command, jobs) => {
  const dir = tmpDir();
  const base = loadConfigForPreset(command, {}, { root: dir });
  const config = Object.assign(testConfig(dir), { filters: base.filters, preset: base.preset });
  return runFreshScan({ config, now: NOW, persist: false, fetchImpl: mockFetch([[/.*/, () => ({ __status: 404 })]]), deps: deps(freshStore(dir), [src(jobs)]) });
};

test('remote preset: only Remote (US) jobs reach the results', async () => {
  const r = await scanPreset('remote', [atsJob(1, { location: 'Remote - US' }), atsJob(2, { location: 'New York, NY' })]);
  assert.deepEqual(r.top.map((t) => t.company), ['Acme 1']);
  assert.equal(r.counts.excluded['not remote (US)'], 1);
  assert.equal(r.preset.name, 'remote');
});

test('local preset: CT/NY/NJ/MA or US-remote', async () => {
  const r = await scanPreset('local', [atsJob(1, { location: 'Stamford, CT' }), atsJob(2, { location: 'Remote' }), atsJob(3, { location: 'Austin, TX' })]);
  assert.deepEqual(r.top.map((t) => t.company).sort(), ['Acme 1', 'Acme 2']);
});

test('company preset: only that company; LinkedIn-only hits still need employer verification (strict gate unchanged)', async () => {
  const amazonBoard = atsJob(1, { company: 'Amazon', url: 'https://www.amazon.jobs/en/jobs/2900001/data-scientist', postedEvidence: EVIDENCE.DAY,
    postedDay: new Date(NOW).toISOString().slice(0, 10), postedAt: Date.parse(`${new Date(NOW).toISOString().slice(0, 10)}T00:00:00Z`) });
  const amazonLinkedIn = makeJob({ source: 'apify-linkedin', sourceJobId: 'x', url: 'https://www.linkedin.com/jobs/view/5', company: 'Amazon Web Services (AWS)',
    title: 'Machine Learning Engineer', location: 'Seattle, WA', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR, description: GOOD_JD });
  const r = await scanPreset('company Amazon', [amazonBoard, amazonLinkedIn, atsJob(2, { company: 'Globex' })]);
  assert.deepEqual(r.top.map((t) => t.company), ['Amazon']);
  assert.match(r.top[0].applyUrl, /^https:\/\/www\.amazon\.jobs\//);
  assert.equal(r.counts.excluded['outside preset companies'], 1);
  assert.equal(r.counts.excluded['original freshness unverifiable'], 1);
});

test('output columns: Posted | Fit /5 | Company | Job Title | Location | Salary | Eligibility | Why it matches | Apply', async () => {
  const r = await scanPreset('run', [atsJob(1)]);
  const md = renderMarkdown(r);
  assert.match(md, /\| Posted \| Fit \/5 \| Company \| Job Title \| Location \| Salary \| Eligibility \| Why it matches \| Apply \|/);
  assert.match(md, /\[Apply\]\(https:\/\/job-boards\.greenhouse\.io\/acme1\/jobs\/1001\)/);
});
