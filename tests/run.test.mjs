import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { runFreshScan, Deduper } from '../src/engine/run.mjs';
import { applyLimits, DEFAULTS, LIMITS } from '../src/engine/config.mjs';
import { SeenStore } from '../src/engine/seen-store.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { NOW, HOUR, DAY, atsJob, tmpDir, testConfig, deps, freshStore, mockFetch, GOOD_JD } from './helpers.mjs';

const ALLOWED_HOSTS = new Set(['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', 'api.apify.com']);

// A source that emits jobs, then waits until told to stop (well-behaved).
const politeSource = (id, jobs) => ({
  id,
  async run(ctx) {
    ctx.emit(jobs);
    await new Promise((r) => (ctx.signal.aborted ? r() : ctx.signal.addEventListener('abort', r, { once: true })));
    return { emitted: jobs.length };
  },
});
// A source that emits jobs and then ignores every signal (misbehaving).
const stuckSource = (id, jobs) => ({ id, async run(ctx) { ctx.emit(jobs); await new Promise(() => {}); } });

const liJob = (i, patch = {}) => makeJob({
  source: 'apify-linkedin', sourceJobId: `li-${i}`, url: `https://www.linkedin.com/jobs/view/${i}`,
  company: `Globex ${i}`, title: 'AI Engineer', location: 'Remote', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR,
  description: GOOD_JD, ...patch,
});

test('early stop: 10 strong jobs stop discovery immediately and return Top 10 (no network)', async () => {
  const dir = tmpDir();
  const log = [];
  const jobs = Array.from({ length: 12 }, (_, i) => atsJob(i));
  const t0 = Date.now();
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch([], log), deps: deps(freshStore(dir), [politeSource('tracked', jobs)]) });
  assert.equal(r.earlyStop, true);
  assert.match(r.sourcesStopReason, /early stop/);
  assert.equal(r.top.length, 10);
  assert.ok(r.top.every((t) => t.status === 'NEW' && t.eligibility === 'OK' && t.fit >= 4 && t.employerConfirmed));
  assert.ok(Date.now() - t0 < 1500, 'returns right away');
  assert.equal(r.partial, false);
  assert.equal(log.length, 0, 'no fetches needed');
  assert.equal(r.apify.spentUsd, 0);
});

test('soft deadline: a source that never finishes is cut off; best partial result returned', async () => {
  const dir = tmpDir();
  const config = testConfig(dir, { sourceBudgetMs: 100, softMs: 300, hardMs: 3000 });
  const t0 = Date.now();
  const r = await runFreshScan({ config, now: NOW, persist: false, fetchImpl: mockFetch([]), deps: deps(freshStore(dir), [stuckSource('tracked', [atsJob(1), atsJob(2)])]) });
  const ms = Date.now() - t0;
  assert.ok(ms >= 250 && ms < 1500, `took ${ms}ms`);
  assert.equal(r.partial, true);
  assert.match(r.stopReason, /soft/);
  assert.equal(r.top.length, 2);
});

test('hard deadline: everything stops, partial result still ranked', async () => {
  const dir = tmpDir();
  const config = testConfig(dir, { sourceBudgetMs: 5000, softMs: 5000, hardMs: 200 });
  const t0 = Date.now();
  const r = await runFreshScan({ config, now: NOW, persist: false, fetchImpl: mockFetch([]), deps: deps(freshStore(dir), [stuckSource('tracked', [atsJob(1), atsJob(2), atsJob(3)])]) });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms}ms`);
  assert.equal(r.partial, true);
  assert.match(r.stopReason, /hard/);
  assert.equal(r.top.length, 3);
});

test('aggregator job confirmed at employer becomes NEW with the official apply URL; unconfirmed is excluded', async () => {
  const dir = tmpDir();
  const log = [];
  const fetchImpl = mockFetch([
    [/boards-api\.greenhouse\.io\/v1\/boards\/globex1\/jobs$/, () => ({ jobs: [{ title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/globex1/jobs/1', location: { name: 'Remote' }, first_published: new Date(NOW - 2 * HOUR).toISOString() }] })],
    [/.*/, () => ({ __status: 404 })],
  ], log);
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl, deps: deps(freshStore(dir), [politeSource('apify', [liJob(1), liJob(2)])]) });
  assert.equal(r.top.length, 1);
  assert.equal(r.top[0].company, 'Globex 1');
  assert.equal(r.top[0].status, 'NEW');
  assert.equal(r.top[0].applyUrl, 'https://job-boards.greenhouse.io/globex1/jobs/1');
  assert.match(r.top[0].discoveryUrl, /linkedin\.com/, 'LinkedIn kept only as the discovery reference');
  assert.equal(r.counts.excluded['original freshness unverifiable'], 1);
  for (const { url } of log) assert.ok(ALLOWED_HOSTS.has(new URL(url).hostname), `unexpected host ${url}`);
});

test('job verified through a board listing (no text) gets its text from the employer posting', async () => {
  const dir = tmpDir();
  const published = new Date(NOW - 2 * HOUR).toISOString();
  const fetchImpl = mockFetch([
    [/boards-api\.greenhouse\.io\/v1\/boards\/globex1\/jobs$/, () => ({ jobs: [{ title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/globex1/jobs/1', location: { name: 'Remote' }, first_published: published }] })],
    [/boards-api\.greenhouse\.io\/v1\/boards\/globex1\/jobs\/1$/, () => ({ first_published: published, absolute_url: 'https://job-boards.greenhouse.io/globex1/jobs/1', content: `&lt;p&gt;${GOOD_JD}&lt;/p&gt;` })],
    [/.*/, () => ({ __status: 404 })],
  ]);
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl, deps: deps(freshStore(dir), [politeSource('apify', [liJob(1, { description: '' })])]) });
  assert.equal(r.top.length, 1);
  assert.equal(r.top[0].eligibility, 'OK', 'eligibility checked on the employer text, not VERIFY for missing text');
  assert.equal(r.top[0].salary, '$120K–$150K');
});

test('LinkedIn refresh across scans: verified NEW 30h ago, displayed "1 hour ago" today → excluded as seen', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'seen.json');
  const config = testConfig(dir);
  const board = (publishedMs) => mockFetch([
    [/boards-api\.greenhouse\.io\/v1\/boards\/globex7\/jobs$/, () => ({ jobs: [{ title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/globex7/jobs/7', location: { name: 'Remote' }, first_published: new Date(publishedMs).toISOString() }] })],
    [/.*/, () => ({ __status: 404 })],
  ]);
  const first = await runFreshScan({ config, now: NOW - 30 * HOUR, fetchImpl: board(NOW - 31 * HOUR), deps: deps(new SeenStore({ file }), [politeSource('apify', [liJob(7, { postedAt: NOW - 31 * HOUR })])]) });
  assert.equal(first.top.length, 1, 'verified at the employer on day 1');
  assert.ok(fs.existsSync(file), 'first-seen store persisted');
  const second = await runFreshScan({ config, now: NOW, fetchImpl: board(NOW - 31 * HOUR), deps: deps(SeenStore.load(file), [politeSource('apify', [liJob(7, { postedAt: NOW - HOUR })])]) });
  assert.equal(second.top.length, 0);
  assert.equal(second.counts.excluded['seen before'], 1);
});

test('BLOCKED jobs never enter the Top 10; undated jobs are excluded; Top ≤ 10', async () => {
  const dir = tmpDir();
  const blocked = atsJob(50, { description: `${GOOD_JD} You must be a U.S. citizen.` });
  const undated = atsJob(51, { postedAt: null });
  const many = Array.from({ length: 20 }, (_, i) => atsJob(i, { title: 'Data Analyst', description: GOOD_JD.replace('2+ years', '4+ years') }));
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch([[/.*/, () => null]]), deps: deps(freshStore(dir), [politeSource('tracked', [blocked, undated, ...many])]) });
  assert.ok(r.top.length <= 10);
  assert.ok(!r.top.some((t) => t.company === 'Acme 50'));
  assert.ok(!r.top.some((t) => t.company === 'Acme 51'));
  assert.equal(r.counts.excluded['eligibility blocked'], 1);
  assert.equal(r.counts.excluded['no reliable date'], 1);
  assert.ok(r.counts.shortlisted <= 15);
});

test('at most 3 workers run, even if more sources are configured', async () => {
  const dir = tmpDir();
  const ran = [];
  const src = (id) => ({ id, async run() { ran.push(id); return {}; } });
  await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch([]), deps: deps(freshStore(dir), ['a', 'b', 'c', 'd'].map(src)) });
  assert.deepEqual(ran, ['a', 'b', 'c']);
});

test('writes fresh.json / fresh.md and latest.json for the dashboard', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  const r = await runFreshScan({ config, now: NOW, persist: false, fetchImpl: mockFetch([]), deps: deps(freshStore(dir), [politeSource('tracked', [atsJob(1)])]) });
  assert.ok(fs.existsSync(path.join(r.outDir, 'fresh.md')));
  const latest = JSON.parse(fs.readFileSync(path.join(config.paths.outDir, 'latest.json'), 'utf8'));
  assert.equal(latest.top.length, 1);
});

test('dedup: same job from LinkedIn and the employer ATS merges, keeping the employer date', () => {
  const d = new Deduper();
  d.add(liJob(1, { company: 'Acme 1', title: 'Machine Learning Engineer', location: 'New York, NY', url: 'https://www.linkedin.com/jobs/view/1' }));
  d.add(atsJob(1));
  const all = d.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].postedEvidence, EVIDENCE.ATS);
  assert.ok(all[0].alsoSeenOn.includes('apify-linkedin'));
  assert.ok(Number.isFinite(all[0].listedAt));
});

test('guardrails are clamped: config can never exceed the agreed limits', () => {
  const c = applyLimits({ ...structuredClone(DEFAULTS), softMs: 999_999, hardMs: 999_999, topN: 50, shortlistMax: 99, jdFetchMax: 100, jdConcurrency: 50, requestTimeoutMs: 60_000,
    sources: { tracked: true, 'ats-rotation': true, apify: true, extra: true },
    apify: { ...structuredClone(DEFAULTS.apify), scanCapUsd: 5, perRunCapUsd: 5 } });
  assert.equal(c.softMs, LIMITS.softMs);
  assert.equal(c.hardMs, LIMITS.hardMs);
  assert.equal(c.topN, 10);
  assert.equal(c.shortlistMax, 15);
  assert.equal(c.jdFetchMax, 25);
  assert.equal(c.jdConcurrency, 8);
  assert.equal(c.requestTimeoutMs, 8000);
  assert.equal(c.apify.scanCapUsd, 0.25);
  assert.ok(c.apify.perRunCapUsd <= 0.25);
  assert.equal(Object.values(c.sources).filter(Boolean).length, 3);
});

test('defaults match the agreed plan', () => {
  assert.equal(DEFAULTS.softMs, 180_000);
  assert.equal(DEFAULTS.hardMs, 300_000);
  assert.equal(DEFAULTS.rotationBatch, 25);
  assert.equal(DEFAULTS.apify.scanCapUsd, 0.10);
  assert.equal(DEFAULTS.apify.actors.linkedin.input, undefined);
  assert.equal(DEFAULTS.apify.actors.indeed.input.datePosted, '1');
  void DAY;
});

test('top list: one posting reached via two location strings appears once', async () => {
  const { uniqueByApplyUrl } = await import('../src/engine/run.mjs');
  const a = { job: atsJob(1, { location: 'New York City · USA · US Remote' }) };
  const b = { job: atsJob(1, { location: 'New York City', sourceJobId: 'gh-1b' }) };
  const c = { job: atsJob(2) };
  const tracked = { job: atsJob(3, { url: 'https://job-boards.greenhouse.io/acme3/jobs/1003?gh_src=abc' }) };
  const plain = { job: atsJob(3, { url: 'https://job-boards.greenhouse.io/acme3/jobs/1003/' }) };
  const embedA = { job: atsJob(4, { url: 'https://boards.greenhouse.io/embed/job_app?token=111' }) };
  const embedB = { job: atsJob(5, { url: 'https://boards.greenhouse.io/embed/job_app?token=222' }) };
  const out = uniqueByApplyUrl([a, b, c, tracked, plain, embedA, embedB]);
  assert.deepEqual(out, [a, c, tracked, embedA, embedB]);
});
