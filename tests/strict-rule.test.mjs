// STRICT RULE (docs/GUARDRAILS.md): final results contain ONLY jobs
// that are (1) newly posted ≤24h per the employer, (2) never seen / reposted /
// refreshed, (3) live on the official employer/ATS page, (4) applied to via
// that official URL. Plus the Apify cost-floor fix from the first real scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFreshScan, finalGateReason } from '../src/engine/run.mjs';
import { runActorBounded } from '../src/engine/apify-client.mjs';
import apifySource, { runCost } from '../src/engine/sources/apify.mjs';
import { CostLedger, createClock } from '../src/engine/runtime.mjs';
import { SeenStore } from '../src/engine/seen-store.mjs';
import { makeJob, EVIDENCE, verifiedApplyUrl } from '../src/engine/job.mjs';
import { STATUS } from '../src/engine/freshness.mjs';
import { NOW, HOUR, DAY, atsJob, tmpDir, testConfig, deps, freshStore, mockFetch, GOOD_JD } from './helpers.mjs';
import { workdayDetail, apifyRunRecord, LINKEDIN_ITEM } from './fixtures.mjs';

const politeSource = (jobs) => ({
  id: 'src',
  async run(ctx) {
    ctx.emit(jobs);
    await new Promise((r) => (ctx.signal.aborted ? r() : ctx.signal.addEventListener('abort', r, { once: true })));
    return {};
  },
});
const scan = (dir, jobs, { store = freshStore(dir), routes = [[/.*/, () => ({ __status: 404 })]], log } = {}) =>
  runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch(routes, log), deps: deps(store, [politeSource(jobs)]) });

const li = (i, patch = {}) => makeJob({
  source: 'apify-linkedin', sourceJobId: `li-${i}`, url: `https://www.linkedin.com/jobs/view/${i}`,
  company: `Globex ${i}`, title: 'AI Engineer', location: 'Remote', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR,
  description: GOOD_JD, ...patch,
});

// ── finalGateReason: every exclusion class ───────────────────────────

const ev = (job, status, elig = 'OK') => ({ job, fresh: { status, fresh: status === STATUS.NEW }, elig: { eligibility: elig } });

test('gate: only NEW + live + official apply link + not BLOCKED passes', () => {
  assert.equal(finalGateReason(ev(atsJob(1), STATUS.NEW)), null);
  assert.equal(finalGateReason(ev(atsJob(1), STATUS.SEEN)), 'seen before');
  assert.equal(finalGateReason(ev(atsJob(1), STATUS.POSSIBLE_REPOST)), 'possible repost');
  assert.equal(finalGateReason(ev(atsJob(1), STATUS.VERIFY)), 'original freshness unverifiable');
  assert.equal(finalGateReason(ev(atsJob(1), STATUS.STALE)), 'older than 24h');
  assert.equal(finalGateReason(ev(atsJob(1), STATUS.NEW, 'BLOCKED')), 'eligibility blocked');
  assert.equal(finalGateReason(ev(atsJob(1, { liveVerified: false }), STATUS.NEW)), 'no live employer page verified');
  assert.equal(finalGateReason(ev({ ...atsJob(1), closedAtEmployer: true }, STATUS.NEW)), 'closed at employer');
  const aggOnly = atsJob(1, { url: 'https://www.linkedin.com/jobs/view/9', employerUrl: '' });
  assert.equal(verifiedApplyUrl(aggOnly), '');
  assert.equal(finalGateReason(ev(aggOnly, STATUS.NEW)), 'aggregator-only apply link');
});

// ── End-to-end exclusions ────────────────────────────────────────────

test('SEEN earlier today (still ≤24h) → excluded', async () => {
  const dir = tmpDir();
  const store = new SeenStore({});
  store.upsert(atsJob(1), NOW - 3 * HOUR);
  const r = await scan(dir, [atsJob(1), atsJob(2)], { store });
  assert.deepEqual(r.top.map((t) => t.company), ['Acme 2']);
  assert.equal(r.counts.excluded['seen before'], 1);
});

test('POSSIBLE_REPOST (same company/title/location seen 5 days ago, new id) → excluded', async () => {
  const dir = tmpDir();
  const store = new SeenStore({});
  store.upsert(atsJob(1, { sourceJobId: 'old', url: 'https://job-boards.greenhouse.io/acme1/jobs/1' }), NOW - 5 * DAY);
  const r = await scan(dir, [atsJob(1)], { store });
  assert.equal(r.top.length, 0);
  assert.equal(r.counts.excluded['possible repost'], 1);
});

test('LinkedIn/Indeed-only job (not found at employer) → excluded, even if listed 10 minutes ago', async () => {
  const dir = tmpDir();
  const r = await scan(dir, [li(1, { postedAt: NOW - 10 * 60_000 })]);
  assert.equal(r.top.length, 0);
  assert.equal(r.counts.excluded['original freshness unverifiable'], 1);
});

test('employer site without a readable ATS (no date, no live proof) → excluded', async () => {
  const dir = tmpDir();
  const r = await scan(dir, [li(2, { employerUrl: 'https://apply.workable.com/j/60522F7513' })]);
  assert.equal(r.top.length, 0);
});

test('official posting closed at the employer (Workday canApply:false) → excluded', async () => {
  const dir = tmpDir();
  const wd = atsJob(3, {
    url: 'https://umbrella.wd12.myworkdayjobs.com/umbrella_external/job/Anywhere-in-the-US/Senior-Data-Scientist_R2690',
    title: 'Senior Data Scientist', description: '', postedEvidence: EVIDENCE.DAY,
    postedAt: Date.parse(`${new Date(NOW).toISOString().slice(0, 10)}T00:00:00Z`), postedDay: new Date(NOW).toISOString().slice(0, 10),
  });
  const r = await scan(dir, [wd], { routes: [[/wday\/cxs/, () => workdayDetail({ canApply: false })], [/.*/, () => ({ __status: 404 })]] });
  assert.equal(r.top.length, 0);
  assert.equal(r.counts.excluded['closed at employer'], 1);
});

test('aggregator job whose employer Greenhouse posting is gone (404) → excluded', async () => {
  const dir = tmpDir();
  const r = await scan(dir, [li(4, { employerUrl: 'https://job-boards.greenhouse.io/globex4/jobs/444' })]);
  assert.equal(r.top.length, 0);
});

test('verified job: apply link is the official ATS URL, never LinkedIn/Indeed', async () => {
  const dir = tmpDir();
  const routes = [
    [/boards-api\.greenhouse\.io\/v1\/boards\/globex5\/jobs$/, () => ({ jobs: [{ title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/globex5/jobs/5', location: { name: 'Remote' }, first_published: new Date(NOW - 2 * HOUR).toISOString() }] })],
    [/.*/, () => ({ __status: 404 })],
  ];
  const r = await scan(dir, [li(5), li(6)], { routes });
  assert.equal(r.top.length, 1);
  assert.equal(r.top[0].applyUrl, 'https://job-boards.greenhouse.io/globex5/jobs/5');
  assert.ok(!/linkedin|indeed/.test(r.top[0].applyUrl));
  assert.match(r.top[0].liveVia, /greenhouse board/);
});

test('fewer qualifying jobs → fewer rows (never padded)', async () => {
  const dir = tmpDir();
  const r = await scan(dir, [atsJob(1), li(7), li(8), atsJob(9, { postedAt: NOW - 3 * DAY })]);
  assert.equal(r.top.length, 1);
  assert.ok(r.top.every((t) => t.status === 'NEW' && t.employerConfirmed));
});

// ── Cost floor (first real scan read back only start fees) ───────────

test('cost: a lagging charge never books less than items × price + start fee', () => {
  assert.equal(runCost({ chargedUsd: 0.001, chargeComplete: false, items: 15, pricePerItemUsd: 0.0005, startUsd: 0.001, grant: 0.01 }), 0.0085);
  assert.equal(runCost({ chargedUsd: 0.007, chargeComplete: true, items: 15, pricePerItemUsd: 0.0005, startUsd: 0.001, grant: 0.01 }), 0.007);
});

test('cost: client re-reads while charged items < items received; reports incomplete if it never catches up', async () => {
  let reads = 0;
  const lagging = { ...apifyRunRecord({ items: 15, itemPrice: 0.0004 }), chargedEventCounts: { 'apify-actor-start': 1 } };
  const fetchImpl = mockFetch([
    [/\/acts\/[^/]+\/runs\?/, () => ({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } })],
    [/\/datasets\/ds1\/items/, () => Array.from({ length: 15 }, (_, i) => ({ id: i }))],
    [/\/actor-runs\/run1$/, () => { reads++; return { data: lagging }; }],
  ]);
  const res = await runActorBounded({ actorId: 'a/b', input: {}, token: 't', maxChargeUsd: 0.01, timeoutSec: 30, maxItems: 15,
    stopSignal: new AbortController().signal, hardSignal: new AbortController().signal, pollMs: 1, costRetryMs: 1, fetchImpl });
  assert.equal(reads, 3, 'three reads, then give up');
  assert.equal(res.chargeComplete, false);
});

test('cost: with lagging charges the ledger still books real spend and stays under the scan cap', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  Object.assign(config.apify, { pollMs: 1, costRetryMs: 1 });
  const lagging = { ...apifyRunRecord({ items: 15, itemPrice: 0.0004 }), chargedEventCounts: { 'apify-actor-start': 1 } };
  const fetchImpl = mockFetch([
    [/\/acts\/[^/]+\/runs\?/, () => ({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } })],
    [/\/datasets\/ds1\/items/, () => Array.from({ length: 15 }, (_, i) => ({ ...LINKEDIN_ITEM, id: `${i}` }))],
    [/\/actor-runs\/run1$/, () => ({ data: lagging })],
  ]);
  const clock = createClock({ sourceBudgetMs: 5000, softMs: 6000, hardMs: 8000 });
  const ledger = new CostLedger({ capUsd: config.apify.scanCapUsd, perRunCapUsd: config.apify.perRunCapUsd });
  const r = await apifySource.run({ config, env: { APIFY_TOKEN: 't' }, fetchImpl, clock, ledger, signal: clock.sourcesSignal, hardSignal: clock.hardSignal,
    now: NOW, store: new SeenStore({}), emit: () => {}, prefilter: () => true, strongCount: () => 0 });
  clock.dispose();
  const done = r.runs.filter((x) => x.status);
  assert.ok(done.every((x) => x.costUsd >= 0.0025 && x.costSource === 'floor-estimate'), JSON.stringify(done));
  assert.ok(ledger.summary().spentUsd <= config.apify.scanCapUsd + 1e-9);
  assert.ok(ledger.summary().spentUsd > 0.012, 'no longer undercounts like the first real scan');
});
