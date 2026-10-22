import test from 'node:test';
import assert from 'node:assert/strict';
import { runActorBounded, APIFY_TOKEN_HELP } from '../src/engine/apify-client.mjs';
import apifySource, { runCost } from '../src/engine/sources/apify.mjs';
import { linkedinAdapter } from '../src/engine/sources/apify-linkedin.mjs';
import { indeedAdapter } from '../src/engine/sources/apify-indeed.mjs';
import { CostLedger, createClock } from '../src/engine/runtime.mjs';
import { EVIDENCE } from '../src/engine/job.mjs';
import { SeenStore } from '../src/engine/seen-store.mjs';
import { mockFetch, NOW, tmpDir, testConfig } from './helpers.mjs';

const TOKEN = 'apify_api_TESTTOKEN';

function apifyRoutes({ items = [], statusSeq = ['RUNNING', 'SUCCEEDED'], usage = 0.001 } = {}) {
  let polls = 0;
  return [
    [/\/acts\/[^/]+\/runs\?/, () => ({ data: { id: 'run1', status: 'READY', defaultDatasetId: 'ds1' } })],
    [/\/actor-runs\/run1\/abort/, () => ({ data: { id: 'run1', status: 'ABORTED', defaultDatasetId: 'ds1' } })],
    [/\/actor-runs\/run1$/, () => ({ data: { id: 'run1', status: statusSeq[Math.min(polls++, statusSeq.length - 1)], defaultDatasetId: 'ds1', usageTotalUsd: usage } })],
    [/\/datasets\/ds1\/items/, () => items],
  ];
}

const signals = () => ({ stopSignal: new AbortController().signal, hardSignal: new AbortController().signal });

test('client: spend cap + timeout sent as query params; token only in the Authorization header', async () => {
  const log = [];
  const res = await runActorBounded({
    actorId: 'valig/linkedin-jobs-scraper', input: { keywords: 'AI Engineer' }, token: TOKEN,
    maxChargeUsd: 0.01, timeoutSec: 60, maxItems: 15, ...signals(), pollMs: 1, costRetryMs: 1,
    fetchImpl: mockFetch(apifyRoutes({ items: [{ id: 1 }, { id: 2 }] }), log),
  });
  assert.equal(res.items.length, 2);
  assert.equal(res.status, 'SUCCEEDED');
  const start = new URL(log[0].url);
  assert.equal(start.pathname, '/v2/acts/valig~linkedin-jobs-scraper/runs');
  assert.equal(start.searchParams.get('maxTotalChargeUsd'), '0.01');
  assert.equal(start.searchParams.get('timeout'), '60');
  assert.equal(start.searchParams.get('maxItems'), '15');
  for (const { url, init } of log) {
    assert.ok(!url.includes(TOKEN), 'token never in a URL');
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  }
});

test('client: stop signal aborts the run remotely and keeps items already pushed', async () => {
  const log = [];
  const stop = new AbortController();
  setTimeout(() => stop.abort('source budget'), 20);
  const res = await runActorBounded({
    actorId: 'valig/indeed-jobs-scraper', input: {}, token: TOKEN, maxChargeUsd: 0.01, timeoutSec: 60, maxItems: 15,
    stopSignal: stop.signal, hardSignal: new AbortController().signal, pollMs: 5, costRetryMs: 1,
    fetchImpl: mockFetch(apifyRoutes({ items: [{ key: 'a' }], statusSeq: ['RUNNING'] }), log),
  });
  assert.equal(res.aborted, true);
  assert.ok(log.some((l) => /\/abort$/.test(l.url)), 'abort called');
  assert.equal(res.items.length, 1);
});

test('client: missing token → clear instructions, no network call', async () => {
  const log = [];
  await assert.rejects(runActorBounded({ actorId: 'a/b', token: '', ...signals(), fetchImpl: mockFetch([], log) }), /console\.apify\.com/);
  assert.equal(log.length, 0);
  assert.match(APIFY_TOKEN_HELP, /\.env/);
});

test('ledger: reservations can never exceed the scan cap', () => {
  const l = new CostLedger({ capUsd: 0.10, perRunCapUsd: 0.03 });
  const grants = [];
  for (let i = 0; i < 10; i++) grants.push(l.reserve(`r${i}`));
  assert.ok(grants.reduce((a, b) => a + b, 0) <= 0.10 + 1e-9);
  assert.equal(grants.at(-1), 0);
});

test('ledger: actual spend releases unused reservation', () => {
  const l = new CostLedger({ capUsd: 0.02, perRunCapUsd: 0.01 });
  l.reserve('a'); l.record('a', 0.002);
  l.reserve('b'); l.record('b', 0.002);
  assert.ok(l.reserve('c') > 0, 'released budget is reusable');
  assert.ok(l.summary().spentUsd <= 0.02);
});

test('runCost: unknown cost after a hard stop assumes the full grant', () => {
  assert.equal(runCost({ usageUsd: null, items: 0, pricePerItemUsd: 0.0005, startUsd: 0, grant: 0.01, readFailed: true }), 0.01);
  assert.equal(runCost({ usageUsd: 0, items: 10, pricePerItemUsd: 0.0005, startUsd: 0.0001, grant: 0.01, readFailed: false }), 0.0051);
});

test('linkedin adapter: listing time is aggregator evidence, never credible', () => {
  const j = linkedinAdapter.mapItem({ id: '4001', url: 'https://www.linkedin.com/jobs/view/4001', title: 'AI Engineer', companyName: 'Globex', location: 'New York, NY', postedTimeAgo: '2 hours ago', description: 'x' }, NOW);
  assert.equal(j.postedEvidence, EVIDENCE.AGGREGATOR);
  assert.equal(j.postedAt, NOW - 2 * 3_600_000);
  assert.equal(j.employerUrl, '');
  const input = linkedinAdapter.buildInput('AI Engineer', { limit: 15, skipIds: ['1'] });
  assert.deepEqual(input, { keywords: 'AI Engineer', location: 'United States', datePosted: 'r86400', limit: 15, skipJobId: ['1'] });
});

test('indeed adapter: employer jobUrl becomes employerUrl; salary + nested fields mapped', () => {
  const j = indeedAdapter.mapItem({
    key: 'abc', url: 'https://www.indeed.com/viewjob?jk=abc', jobUrl: 'https://job-boards.greenhouse.io/globex/jobs/55',
    title: 'Data Scientist', employer: { name: 'Globex' }, location: { city: 'Boston', admin1Code: 'MA', countryCode: 'US' },
    datePublished: '2026-10-11T10:00:00Z', description: { text: 'desc' }, baseSalary: { min: 100000, max: 130000, unitOfWork: 'YEAR' },
  }, NOW);
  assert.equal(j.employerUrl, 'https://job-boards.greenhouse.io/globex/jobs/55');
  assert.equal(j.location, 'Boston, MA, US');
  assert.equal(j.company, 'Globex');
  assert.equal(j.postedEvidence, EVIDENCE.AGGREGATOR);
  assert.deepEqual(indeedAdapter.buildInput('Data Scientist', { limit: 15 }), { country: 'us', title: 'Data Scientist', limit: 15, datePosted: '1' });
});

test('source: no token → skipped with help, zero spend, no network', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  const log = [];
  const r = await apifySource.run({ config, env: {}, fetchImpl: mockFetch([], log) });
  assert.equal(r.skipped, 'APIFY_TOKEN missing');
  assert.equal(log.length, 0);
});

test('source: waves stop once a strong Top 10 exists; spend stays under cap', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  config.apify.pollMs = 1;
  config.apify.costRetryMs = 1;
  const clock = createClock({ sourceBudgetMs: 2000, softMs: 3000, hardMs: 5000 });
  const ledger = new CostLedger({ capUsd: config.apify.scanCapUsd, perRunCapUsd: config.apify.perRunCapUsd });
  const log = [];
  const items = Array.from({ length: 15 }, (_, i) => ({ id: `${i}`, url: `https://www.linkedin.com/jobs/view/${i}`, title: 'AI Engineer', companyName: `C${i}`, postedTimeAgo: '1 hour ago' }));
  const emitted = [];
  const r = await apifySource.run({
    config, env: { APIFY_TOKEN: TOKEN }, fetchImpl: mockFetch(apifyRoutes({ items }), log), clock, ledger,
    signal: clock.sourcesSignal, hardSignal: clock.hardSignal, now: NOW, store: new SeenStore({}),
    emit: (j) => emitted.push(...j), prefilter: () => true, strongCount: () => 10,
  });
  clock.dispose();
  assert.equal(r.waves, 1, 'secondary/adjacent waves skipped');
  assert.match(r.stoppedBecause, /early stop/);
  assert.equal(r.runs.length, 6, '3 primary queries × 2 actors');
  assert.ok(ledger.summary().spentUsd <= config.apify.scanCapUsd);
  const caps = log.filter((l) => /\/runs\?/.test(l.url)).map((l) => Number(new URL(l.url).searchParams.get('maxTotalChargeUsd')));
  assert.ok(caps.every((c) => c > 0 && c <= config.apify.perRunCapUsd));
  assert.ok(emitted.length > 0);
});
