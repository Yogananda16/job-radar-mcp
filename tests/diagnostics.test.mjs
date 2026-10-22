// Tests for: (1) dead-board skipping in the rotation, (2) per-board failure
// reasons, (3) the age breakdown. Mocks only — no network, no real state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadDeadBoards } from '../src/vendor/dead-boards.mjs';
import rotationSource, { filterDeadBoards, buildRotationList, pickBatch, loadState } from '../src/engine/sources/ats-rotation.mjs';
import { runBoards, classifyFailure } from '../src/engine/boards.mjs';
import { ageBreakdown, summarizeFailures, runFreshScan, AGE_BUCKETS } from '../src/engine/run.mjs';
import { renderMarkdown } from '../src/engine/report.mjs';
import { classifyFreshness } from '../src/engine/freshness.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { NOW, HOUR, DAY, tmpDir, testConfig, deps, freshStore, mockFetch, atsJob } from './helpers.mjs';

// ── 1. Dead-board skipping ───────────────────────────────────────────

function deadFile(dir, rows) {
  const file = path.join(dir, 'dead-boards.tsv');
  fs.writeFileSync(file, `ats\tboard\tmisses\tlast_checked\n${rows.map((r) => r.join('\t')).join('\n')}\n`);
  return file;
}

test('1: boards with 3+ recent misses are skipped; 2 misses or a stale (30d+) record are kept', () => {
  const dir = tmpDir();
  const recent = new Date(NOW - DAY).toISOString();
  const old = new Date(NOW - 40 * DAY).toISOString();
  const rows = loadDeadBoards(deadFile(dir, [
    ['greenhouse', 'https://job-boards.greenhouse.io/deadco', '3', recent],
    ['lever', 'https://jobs.lever.co/flaky', '2', recent],
    ['ashby', 'https://jobs.ashbyhq.com/revived', '3', old],
  ]), NOW);
  const { usable, skipped } = filterDeadBoards(['greenhouse:deadco', 'lever:flaky', 'ashby:revived', 'greenhouse:alive'], rows, NOW);
  assert.deepEqual(usable, ['lever:flaky', 'ashby:revived', 'greenhouse:alive']);
  assert.equal(skipped, 1);
});

test('1: a batch is 25 usable boards even when dead boards are interleaved', () => {
  const dir = tmpDir();
  const recent = new Date(NOW - DAY).toISOString();
  const slugs = Array.from({ length: 60 }, (_, i) => `co${String(i).padStart(2, '0')}`);
  const deadSlugs = slugs.filter((_, i) => i % 2 === 0); // every other board dead
  const rows = loadDeadBoards(deadFile(dir, deadSlugs.map((s) => ['greenhouse', `https://job-boards.greenhouse.io/${s}`, '3', recent])), NOW);
  const list = buildRotationList({ greenhouse: slugs, lever: [], ashby: [] });
  const { usable } = filterDeadBoards(list, rows, NOW);
  const { batch } = pickBatch(usable, {}, 25);
  assert.equal(batch.length, 25);
  assert.ok(batch.every((k) => !deadSlugs.includes(k.split(':')[1])), 'no dead board in the batch');
});

test('1: rotation source end-to-end — dead boards never fetched; state written only to the temp file', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  config.rotationBatch = 4;
  const recent = new Date(NOW - DAY).toISOString();
  const deadBoards = loadDeadBoards(deadFile(dir, [
    ['greenhouse', 'https://job-boards.greenhouse.io/aaa-dead', '3', recent],
    ['lever', 'https://jobs.lever.co/bbb-dead', '3', recent],
  ]), NOW);
  const requested = [];
  const httpCtx = {
    fetchJson: async (url) => { requested.push(url); return /lever/.test(url) ? [] : { jobs: [] }; },
    fetchText: async (url) => { requested.push(url); return ''; },
    fetchResponse: async (url) => { requested.push(url); return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => '' }; },
    normalizePostingUrl: (u) => u,
  };
  const r = await rotationSource.run({
    config, portals: { tracked_companies: [] }, now: NOW, signal: new AbortController().signal, emit: () => {}, prefilter: () => true,
    httpCtx, deadBoards, fetchJson: async () => null,
    rotationLists: { greenhouse: ['aaa-dead', 'ccc-live'], lever: ['bbb-dead', 'ddd-live'], ashby: ['eee-live'] },
  });
  assert.equal(r.deadSkipped, 2);
  assert.equal(r.listSize, 3);
  assert.equal(r.batch, 3);
  assert.ok(!requested.some((u) => /aaa-dead|bbb-dead/.test(u)), `dead board fetched: ${requested.join(', ')}`);
  assert.ok(requested.some((u) => /ccc-live/.test(u)) && requested.some((u) => /ddd-live/.test(u)));
  assert.equal(loadState(config.stateFile).rotation.total, 3, 'cursor written to the test temp file');
  assert.ok(config.stateFile.startsWith(dir));
});

// ── 2. Failure reasons ───────────────────────────────────────────────

test('2: classifyFailure buckets http / timeout / network / error', () => {
  assert.deepEqual(classifyFailure(Object.assign(new Error('HTTP 404 Not Found'), { status: 404 })).reason, 'http');
  assert.equal(classifyFailure(Object.assign(new Error('HTTP 429'), { status: 429 })).status, 429);
  assert.equal(classifyFailure(new Error('x'), { boardTimedOut: true }).reason, 'timeout');
  assert.equal(classifyFailure(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).reason, 'timeout');
  assert.equal(classifyFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).reason, 'network');
  assert.equal(classifyFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code, 'ENOTFOUND');
  assert.equal(classifyFailure(new SyntaxError('Unexpected token < in JSON')).reason, 'error');
});

test('2: every failed board records board, company, provider, status, reason, elapsed time', async () => {
  const providers = {
    http: { id: 'greenhouse', fetch: async () => { throw Object.assign(new Error('HTTP 404 Not Found'), { status: 404 }); } },
    hang: { id: 'workday', fetch: () => new Promise(() => {}) },
    dns: { id: 'lever', fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } },
    bad: { id: 'ashby', fetch: async () => { throw new SyntaxError('Unexpected token < in JSON'); } },
    ok: { id: 'greenhouse', fetch: async () => [] },
  };
  const boards = Object.entries(providers).map(([k, provider]) => ({ entry: { name: `Co-${k}`, careers_url: `https://x.example/${k}` }, provider, key: `tracked:Co-${k}` }));
  const r = await runBoards(boards, { signal: new AbortController().signal, emit: () => {}, source: 'tracked', perBoardMs: 80, concurrency: 5, httpCtx: {} });
  assert.equal(r.failures.length, 4);
  const by = Object.fromEntries(r.failures.map((f) => [f.company, f]));
  assert.deepEqual([by['Co-http'].reason, by['Co-http'].status, by['Co-http'].provider], ['http', 404, 'greenhouse']);
  assert.deepEqual([by['Co-hang'].reason, by['Co-hang'].provider], ['timeout', 'workday']);
  assert.ok(by['Co-hang'].elapsedMs >= 70);
  assert.deepEqual([by['Co-dns'].reason, by['Co-dns'].code], ['network', 'ENOTFOUND']);
  assert.equal(by['Co-bad'].reason, 'error');
  for (const f of r.failures) for (const k of ['board', 'company', 'provider', 'reason', 'elapsedMs', 'url']) assert.ok(k in f, `${k} missing`);
});

test('2: a board cut off by the scan stop is "unfinished", not a failure', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort('budget'), 30);
  const r = await runBoards([{ entry: { name: 'H' }, provider: { id: 'workday', fetch: () => new Promise(() => {}) }, key: 'h' }],
    { signal: stop.signal, emit: () => {}, source: 'tracked', perBoardMs: 10_000, concurrency: 1, httpCtx: {} });
  assert.equal(r.failures.length, 0);
  assert.deepEqual(r.unfinished, ['h']);
});

test('2: failure summary appears in the result and in the Markdown output', async () => {
  const dir = tmpDir();
  const failing = { id: 'tracked', async run() {
    return { failures: [
      { board: 'tracked:Acme', company: 'Acme', provider: 'greenhouse', reason: 'http', status: 404, elapsedMs: 120 },
      { board: 'tracked:Slow', company: 'Slow Co', provider: 'workday', reason: 'timeout', status: null, elapsedMs: 20_000 },
    ] };
  } };
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch([]), deps: deps(freshStore(dir), [failing]) });
  assert.equal(r.failures.total, 2);
  assert.deepEqual(r.failures.byReason, { 'http 404': 1, timeout: 1 });
  assert.equal(r.failures.list[0].company, 'Slow Co', 'slowest first');
  const md = renderMarkdown(r);
  assert.match(md, /Board failures: 2 — /);
  assert.match(md, /Slow Co \(workday, timeout, 20\.0s\)/);
  assert.deepEqual(summarizeFailures({}), { total: 0, byReason: {}, list: [] });
});

// ── 3. Age breakdown ─────────────────────────────────────────────────

function ev(job) { return { job, fresh: classifyFreshness(job, { strongFirstSeen: null, weakFirstSeen: null }, NOW) }; }
const today = new Date(NOW); today.setHours(0, 0, 0, 0);

test('3: age buckets <6h / 6–12h / 12–24h / 1–3d / >3d / day-only / unknown', () => {
  const evaluated = [
    ev(atsJob(1, { postedAt: NOW - 2 * HOUR })),
    ev(atsJob(2, { postedAt: NOW - 8 * HOUR })),
    ev(atsJob(3, { postedAt: NOW - 20 * HOUR })),
    ev(atsJob(4, { postedAt: NOW - 2 * DAY })),
    ev(atsJob(5, { postedAt: NOW - 5 * DAY })),
    ev(atsJob(6, { postedAt: null })),
    ev(atsJob(7, { postedAt: today.getTime(), postedEvidence: EVIDENCE.DAY })),
    ev(makeJob({ source: 'apify-linkedin', sourceJobId: 'x', url: 'https://www.linkedin.com/jobs/view/1', company: 'L', title: 'AI Engineer', postedAt: NOW - 3 * HOUR, postedEvidence: EVIDENCE.AGGREGATOR })),
  ];
  const b = ageBreakdown(evaluated, NOW);
  assert.deepEqual(Object.keys(b), AGE_BUCKETS);
  assert.deepEqual(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.total])),
    { '<6h': 2, '6–12h': 1, '12–24h': 1, '1–3d': 1, '>3d': 1, 'today (day-only)': 1, unknown: 1 });
  assert.equal(b['<6h'].employerDated, 1, 'the LinkedIn listing is counted but not as employer-dated');
});

test('3: breakdown is diagnostic only — a 20h aggregator listing still is not NEW', async () => {
  const dir = tmpDir();
  const li = makeJob({ source: 'apify-linkedin', sourceJobId: 'y', url: 'https://www.linkedin.com/jobs/view/2', company: 'Globex', title: 'AI Engineer', location: 'Remote', postedAt: NOW - 20 * HOUR, postedEvidence: EVIDENCE.AGGREGATOR });
  const src = { id: 'apify', async run(ctx) { ctx.emit([li, atsJob(9, { postedAt: NOW - 30 * HOUR })]); return {}; } };
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch([[/.*/, () => null]]), deps: deps(freshStore(dir), [src]) });
  assert.equal(r.counts.ageBreakdown['12–24h'].total, 1);
  assert.equal(r.counts.ageBreakdown['1–3d'].total, 1);
  assert.ok(r.top.every((t) => t.status !== 'NEW'));
  assert.match(renderMarkdown(r), /Age of evaluated jobs \(diagnostic; Top 10 needs a credible ≤24h date\): 12–24h 1 \(0 employer-dated\) · 1–3d 1/);
});

test('dead boards: 404s accumulate to dead after 3 runs; success resets; timeouts never count', async () => {
  const { recordRotationOutcomes, filterDeadBoards } = await import('../src/engine/sources/ats-rotation.mjs');
  const { shouldSkipDeadBoard } = await import('../src/vendor/dead-boards.mjs');
  const b = (slug) => ({ key: `greenhouse:${slug}`, entry: { careers_url: `https://job-boards.greenhouse.io/${slug}` } });
  const boards = [b('gone'), b('slow'), b('ok')];
  const res = {
    done: ['greenhouse:ok'],
    failures: [
      { board: 'greenhouse:gone', reason: 'http', status: 404 },
      { board: 'greenhouse:slow', reason: 'timeout', status: null },
    ],
  };
  const rows = new Map();
  for (let i = 0; i < 3; i++) recordRotationOutcomes(rows, boards, res, NOW);
  assert.ok(shouldSkipDeadBoard(rows, 'greenhouse', 'https://job-boards.greenhouse.io/gone', NOW));
  assert.ok(!shouldSkipDeadBoard(rows, 'greenhouse', 'https://job-boards.greenhouse.io/slow', NOW));
  assert.equal(filterDeadBoards(['greenhouse:gone', 'greenhouse:ok'], rows, NOW).skipped, 1);
  recordRotationOutcomes(rows, boards, { done: ['greenhouse:gone'], failures: [] }, NOW);
  assert.ok(!shouldSkipDeadBoard(rows, 'greenhouse', 'https://job-boards.greenhouse.io/gone', NOW), 'a board that answers again is revived');
});
