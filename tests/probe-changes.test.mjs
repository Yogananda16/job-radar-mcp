// Tests for the five post-probe changes (2026-10-11):
//   1 exact Apify cost · 2 hidden employer · 3 Indeed mapping
//   4 LinkedIn mapping + salary · 5 Workday / SmartRecruiters verification
import test from 'node:test';
import assert from 'node:assert/strict';
import { runActorBounded, chargedUsd } from '../src/engine/apify-client.mjs';
import apifySource, { runCost } from '../src/engine/sources/apify.mjs';
import { linkedinAdapter } from '../src/engine/sources/apify-linkedin.mjs';
import { indeedAdapter } from '../src/engine/sources/apify-indeed.mjs';
import { parseSalaryK } from '../src/engine/eligibility.mjs';
import { parseWorkdayUrl, parseSmartRecruitersUrl, verifyAtEmployer, workdayStartDay, employerAtsKind } from '../src/engine/ats.mjs';
import { classifyFreshness, STATUS } from '../src/engine/freshness.mjs';
import { runFreshScan, applyEmployerFacts } from '../src/engine/run.mjs';
import { CostLedger, createClock } from '../src/engine/runtime.mjs';
import { SeenStore } from '../src/engine/seen-store.mjs';
import { DEFAULTS } from '../src/engine/config.mjs';
import { EVIDENCE, identityKeys } from '../src/engine/job.mjs';
import { NOW, HOUR, DAY, tmpDir, testConfig, deps, freshStore, mockFetch } from './helpers.mjs';
import {
  LINKEDIN_ITEM, INDEED_WORKDAY, INDEED_SMARTRECRUITERS, INDEED_HIDDEN_EMPLOYER, INDEED_HTTP_EMPLOYER,
  apifyRunRecord, workdayDetail, srDetail,
} from './fixtures.mjs';

const none = { strongFirstSeen: null, weakFirstSeen: null };
const fjFrom = (fetchImpl) => async (u) => { try { const r = await fetchImpl(u); return r.ok ? r.json() : null; } catch { return null; } };
const politeSource = (id, jobs) => ({
  id,
  async run(ctx) {
    ctx.emit(jobs);
    await new Promise((r) => (ctx.signal.aborted ? r() : ctx.signal.addEventListener('abort', r, { once: true })));
    return {};
  },
});

// ── 1. Exact Apify cost ──────────────────────────────────────────────

test('1: cost = charged event counts × event prices (probe: LinkedIn $0.003, Indeed $0.0015)', () => {
  assert.equal(chargedUsd(apifyRunRecord({ items: 5, itemPrice: 0.0004 })), 0.003);
  assert.equal(chargedUsd(apifyRunRecord({ items: 5, itemPrice: 0.0001 })), 0.0015);
  assert.equal(chargedUsd({ status: 'SUCCEEDED' }), null, 'no charge data → null, not 0');
});

test('1: runCost uses the exact charge once complete; fallback estimate uses the $0.001 start fee and is never below actual', () => {
  assert.equal(runCost({ chargedUsd: 0.003, chargeComplete: true, usageUsd: null, items: 5, pricePerItemUsd: 0.0005, startUsd: 0.001, grant: 0.01 }), 0.003);
  assert.equal(runCost({ chargedUsd: 0.001, chargeComplete: false, usageUsd: null, items: 5, pricePerItemUsd: 0.0005, startUsd: 0.001, grant: 0.01 }), 0.0035, 'lagging charge → floor');
  const li = DEFAULTS.apify.actors.linkedin; const ind = DEFAULTS.apify.actors.indeed;
  assert.equal(li.startUsd, 0.001); assert.equal(ind.startUsd, 0.001);
  const estLi = runCost({ items: 5, pricePerItemUsd: li.pricePerItemUsd, startUsd: li.startUsd, grant: 0.01 });
  const estIn = runCost({ items: 5, pricePerItemUsd: ind.pricePerItemUsd, startUsd: ind.startUsd, grant: 0.01 });
  assert.ok(estLi >= 0.003 && estIn >= 0.0015, `estimates ${estLi} / ${estIn} must not undercount`);
  assert.equal(runCost({ chargedUsd: 0.5, items: 5, pricePerItemUsd: 0, startUsd: 0, grant: 0.01 }), 0.01, 'never above the grant');
});

test('1: client re-reads once when charges lag, then reports the exact charge', async () => {
  let reads = 0;
  const fetchImpl = mockFetch([
    [/\/acts\/[^/]+\/runs\?/, () => ({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } })],
    [/\/datasets\/ds1\/items/, () => [{ id: 1 }]],
    [/\/actor-runs\/run1$/, () => ({ data: ++reads === 1 ? apifyRunRecord({ withCharges: false }) : apifyRunRecord({ items: 1, itemPrice: 0.0004 }) })],
  ]);
  const res = await runActorBounded({ actorId: 'a/b', input: {}, token: 't', maxChargeUsd: 0.01, timeoutSec: 30, maxItems: 5,
    stopSignal: new AbortController().signal, hardSignal: new AbortController().signal, pollMs: 1, costRetryMs: 1, fetchImpl });
  assert.equal(res.chargedUsd, 0.0014);
  assert.equal(reads, 2);
});

test('1: the source ledger records Apify-charged cost (probe totals $0.0045)', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  Object.assign(config.apify, { pollMs: 1, costRetryMs: 1, queries: { primary: ['Data Scientist'] } });
  const fetchImpl = mockFetch([
    [/\/acts\/[^/]+\/runs\?/, () => ({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } })],
    [/\/datasets\/ds1\/items/, () => Array.from({ length: 5 }, (_, i) => ({ ...LINKEDIN_ITEM, id: `${i}` }))],
    [/\/actor-runs\/run1$/, () => ({ data: apifyRunRecord({ items: 5, itemPrice: 0.0004 }) })],
  ]);
  const clock = createClock({ sourceBudgetMs: 2000, softMs: 3000, hardMs: 5000 });
  const ledger = new CostLedger({ capUsd: config.apify.scanCapUsd, perRunCapUsd: config.apify.perRunCapUsd });
  const r = await apifySource.run({ config, env: { APIFY_TOKEN: 't' }, fetchImpl, clock, ledger, signal: clock.sourcesSignal,
    hardSignal: clock.hardSignal, now: NOW, store: new SeenStore({}), emit: () => {}, prefilter: () => true, strongCount: () => 0 });
  clock.dispose();
  assert.equal(r.runs.length, 2);
  assert.ok(r.runs.every((x) => x.costSource === 'apify-charged' && x.costUsd === 0.003));
  assert.equal(ledger.summary().spentUsd, 0.006);
});

// ── 2. Hidden employer ───────────────────────────────────────────────

test('2: Indeed employer.name null → company stays empty (never inferred from text or URL)', () => {
  const j = indeedAdapter.mapItem(INDEED_HIDDEN_EMPLOYER, NOW);
  assert.equal(j.company, '');
  assert.equal(j.employerUrl, '', 'indeed.com/job/… is not an employer link');
});

test('2: hidden-employer jobs are excluded from the Top 10 and counted', async () => {
  const dir = tmpDir();
  const hidden = indeedAdapter.mapItem(INDEED_HIDDEN_EMPLOYER, NOW);
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch([[/.*/, () => null]]),
    deps: deps(freshStore(dir), [politeSource('apify', [hidden])]) });
  assert.equal(r.top.length, 0);
  assert.equal(r.counts.excluded['employer hidden'], 1);
});

// ── 3. Indeed mapping ────────────────────────────────────────────────

test('3: refNum becomes the requisition id and part of the job identity', () => {
  const j = indeedAdapter.mapItem(INDEED_WORKDAY, NOW);
  assert.equal(j.requisitionId, 'JOB_POSTING-3-5867');
  assert.ok(identityKeys(j).some((k) => k.startsWith('req:umbrella health:')));
});

test('3: a re-listing with a new Indeed key but the same refNum is SEEN, not NEW', () => {
  const s = new SeenStore({});
  s.upsert(indeedAdapter.mapItem(INDEED_WORKDAY, NOW), NOW - 3 * DAY);
  const relist = indeedAdapter.mapItem({ ...INDEED_WORKDAY, key: 'zzzz', url: 'https://www.indeed.com/viewjob?jk=zzzz' }, NOW);
  const look = s.lookup(relist);
  assert.equal(look.strongFirstSeen, NOW - 3 * DAY);
  assert.equal(classifyFreshness(relist, look, NOW).status, STATUS.SEEN);
});

test('3: isRepost: true → POSSIBLE_REPOST (null/false leaves it alone)', () => {
  const rep = indeedAdapter.mapItem({ ...INDEED_WORKDAY, isRepost: true }, NOW);
  assert.equal(rep.sourceRepost, true);
  assert.equal(classifyFreshness(rep, none, NOW).status, STATUS.POSSIBLE_REPOST);
  assert.equal(indeedAdapter.mapItem(INDEED_WORKDAY, NOW).sourceRepost, false);
});

test('3: http:// employer links are upgraded to https; Indeed-hosted links are not employer links', () => {
  assert.equal(indeedAdapter.mapItem(INDEED_HTTP_EMPLOYER, NOW).employerUrl, 'https://careers.vandelay.example/jobs/123');
  assert.equal(indeedAdapter.mapItem(INDEED_HIDDEN_EMPLOYER, NOW).employerUrl, '');
  assert.equal(indeedAdapter.mapItem(INDEED_WORKDAY, NOW).location, 'Orange, CA, US');
});

// ── 4. LinkedIn mapping + salary ─────────────────────────────────────

test('4: workType (an industry) no longer marks a job remote; "Remote" in location does', () => {
  assert.equal(linkedinAdapter.mapItem(LINKEDIN_ITEM, NOW).remote, false);
  assert.equal(linkedinAdapter.mapItem({ ...LINKEDIN_ITEM, workType: 'Remote' }, NOW).remote, false);
  assert.equal(linkedinAdapter.mapItem({ ...LINKEDIN_ITEM, location: 'United States (Remote)' }, NOW).remote, true);
});

test('4: postedTimeAgo is used (postedDate is day-only); employer link absent', () => {
  const j = linkedinAdapter.mapItem(LINKEDIN_ITEM, NOW);
  assert.equal(j.postedAt, NOW - 3 * HOUR);
  assert.equal(j.postedEvidence, EVIDENCE.AGGREGATOR);
  assert.equal(j.employerUrl, '');
});

test('4: salary formats — LinkedIn "/yr" ranges, hourly, bonus noise skipped', () => {
  assert.deepEqual(parseSalaryK({ salary: { text: LINKEDIN_ITEM.salary } }, ''), { min: 240, max: 300, text: '$240,000.00/yr - $300,000.00/yr' });
  assert.deepEqual(parseSalaryK({}, 'Pay $50 - $60 per hour'), { min: 104, max: 125, text: '$50 - $60 per hour' });
  assert.equal(parseSalaryK({}, 'Sign-on $1,000 bonus. Range $95,000 to $110,000').min, 95);
  assert.equal(parseSalaryK({}, 'No pay listed, $5 coffee'), null);
});

// ── 5. Workday / SmartRecruiters verification ────────────────────────

test('5: Workday URLs → CXS detail endpoint (myworkdayjobs with locale, myworkdaysite); others → null', () => {
  assert.equal(parseWorkdayUrl(INDEED_WORKDAY.jobUrl).cxsUrl,
    'https://umbrella.wd12.myworkdayjobs.com/wday/cxs/umbrella/umbrella_external/job/Anywhere-in-the-US/Senior-Data-Scientist_R2690');
  assert.equal(parseWorkdayUrl('https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston-MA/ML-Engineer_JR-1?src=li').cxsUrl,
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Boston-MA/ML-Engineer_JR-1');
  assert.equal(parseWorkdayUrl('https://wd3.myworkdaysite.com/recruiting/acme/External/job/NYC/DS_R9').cxsUrl,
    'https://wd3.myworkdaysite.com/wday/cxs/acme/External/job/NYC/DS_R9');
  assert.equal(parseWorkdayUrl('https://acme.wd5.myworkdayjobs.com/Careers'), null, 'board page, not a posting');
  assert.equal(employerAtsKind('https://careers.acme.example/job/1'), null);
});

test('5: Workday startDate accepted only as a strict ISO date', () => {
  assert.equal(workdayStartDay('2026-10-11'), '2026-10-11');
  assert.equal(workdayStartDay('2026-10-11T08:30:00Z'), '2026-10-11');
  assert.equal(workdayStartDay('10/11/2026'), null);
  assert.equal(workdayStartDay('2026-10-11T08:30:00'), null, 'no offset → ambiguous → rejected');
});

function liWithEmployer(employerUrl, patch = {}) {
  return { ...indeedAdapter.mapItem({ ...INDEED_WORKDAY, jobUrl: employerUrl }, NOW), ...patch };
}

async function verifyThenClassify(job, routes, store = new SeenStore({})) {
  const v = await verifyAtEmployer(job, { fetchJson: fjFrom(mockFetch(routes)), boardCache: new Map() });
  if (v) { job.employerUrl = v.employerUrl; applyEmployerFacts(job, v); }
  return { v, f: classifyFreshness(job, store.lookup(job), NOW), job };
}

test('5: Workday startDate today → NEW (day-only employer date)', async () => {
  const { v, f } = await verifyThenClassify(liWithEmployer(INDEED_WORKDAY.jobUrl), [[/wday\/cxs/, () => workdayDetail()]]);
  assert.equal(v.evidence, EVIDENCE.DAY);
  assert.equal(f.status, STATUS.NEW);
});

test('5: Workday startDate 9 days ago while Indeed shows fresh → POSSIBLE_REPOST', async () => {
  const { f } = await verifyThenClassify(liWithEmployer(INDEED_WORKDAY.jobUrl), [[/wday\/cxs/, () => workdayDetail({ startDate: new Date(NOW - 9 * DAY).toISOString().slice(0, 10) })]]);
  assert.equal(f.status, STATUS.POSSIBLE_REPOST);
});

test('5: Workday tenant without a usable endpoint/date stays VERIFY (422, HTML, bad date, closed)', async () => {
  for (const handler of [() => ({ __status: 422 }), () => null, () => workdayDetail({ startDate: '10/11/2026' }), () => workdayDetail({ canApply: false })]) {
    const { f } = await verifyThenClassify(liWithEmployer(INDEED_WORKDAY.jobUrl), [[/wday\/cxs/, handler], [/.*/, () => null]]);
    assert.equal(f.status, STATUS.VERIFY);
  }
});

test('5: Workday detail for a different role (recycled link) is ignored → VERIFY', async () => {
  const { f } = await verifyThenClassify(liWithEmployer(INDEED_WORKDAY.jobUrl), [[/wday\/cxs/, () => workdayDetail({ title: 'Warehouse Associate' })], [/.*/, () => null]]);
  assert.equal(f.status, STATUS.VERIFY);
});

test('5: Workday re-release of a req seen 3 days ago (same jobReqId) → SEEN, not NEW', async () => {
  const store = new SeenStore({});
  store.upsert({ ...liWithEmployer('https://umbrella.wd12.myworkdayjobs.com/umbrella_external/job/X/Old_R2690'), sourceJobId: 'old', url: 'https://www.indeed.com/viewjob?jk=old', requisitionId: 'R2690' }, NOW - 3 * DAY);
  const job = liWithEmployer(INDEED_WORKDAY.jobUrl, { requisitionId: '' });
  const { f } = await verifyThenClassify(job, [[/wday\/cxs/, () => workdayDetail()]], store);
  assert.equal(job.requisitionId, 'R2690');
  assert.equal(f.status, STATUS.SEEN);
});

test('5: SmartRecruiters URL → public Posting API', () => {
  assert.equal(parseSmartRecruitersUrl(INDEED_SMARTRECRUITERS.jobUrl).apiUrl, 'https://api.smartrecruiters.com/v1/companies/HOOLI/postings/744000154887278');
  assert.equal(parseSmartRecruitersUrl('https://jobs.smartrecruiters.com/HOOLI'), null);
});

const srJob = () => indeedAdapter.mapItem(INDEED_SMARTRECRUITERS, NOW);

test('5: SmartRecruiters releasedDate (exact) within 24h → NEW', async () => {
  const { v, f } = await verifyThenClassify(srJob(), [[/api\.smartrecruiters\.com/, () => srDetail()]]);
  assert.equal(v.evidence, EVIDENCE.ATS);
  assert.equal(f.status, STATUS.NEW);
});

test('5: SmartRecruiters: old releasedDate → POSSIBLE_REPOST; inactive / date-only / endpoint down → VERIFY', async () => {
  assert.equal((await verifyThenClassify(srJob(), [[/smartrecruiters/, () => srDetail({ releasedDate: new Date(NOW - 20 * DAY).toISOString() })]])).f.status, STATUS.POSSIBLE_REPOST);
  for (const handler of [() => srDetail({ active: false }), () => srDetail({ releasedDate: '2026-10-11' }), () => ({ __status: 404 })]) {
    assert.equal((await verifyThenClassify(srJob(), [[/smartrecruiters/, handler], [/.*/, () => null]])).f.status, STATUS.VERIFY);
  }
});

test('5: SmartRecruiters re-release (new posting id, same refNumber seen before) → SEEN', async () => {
  const store = new SeenStore({});
  store.upsert({ ...srJob(), sourceJobId: 'old', url: 'https://www.indeed.com/viewjob?jk=old', employerUrl: 'https://jobs.smartrecruiters.com/HOOLI/700000000000001-ml', requisitionId: 'REF-7781' }, NOW - 4 * DAY);
  const job = { ...srJob(), requisitionId: '' };
  const { f } = await verifyThenClassify(job, [[/smartrecruiters/, () => srDetail()]], store);
  assert.equal(f.status, STATUS.SEEN);
});

test('5: never promoted on LinkedIn/Indeed timestamps alone', () => {
  const job = indeedAdapter.mapItem(INDEED_WORKDAY, NOW);
  applyEmployerFacts(job, { evidence: EVIDENCE.AGGREGATOR, postedAt: NOW - HOUR });
  applyEmployerFacts(job, { evidence: EVIDENCE.NONE, postedAt: NOW - HOUR });
  assert.equal(job.postedEvidence, EVIDENCE.AGGREGATOR);
  assert.equal(classifyFreshness(job, none, NOW).status, STATUS.VERIFY);
});

test('5: end-to-end — Indeed job with a Workday link becomes NEW with the employer URL', async () => {
  const dir = tmpDir();
  const job = indeedAdapter.mapItem(INDEED_WORKDAY, NOW);
  const log = [];
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false,
    fetchImpl: mockFetch([[/wday\/cxs/, () => workdayDetail()], [/.*/, () => ({ __status: 404 })]], log),
    deps: deps(freshStore(dir), [politeSource('apify', [job])]) });
  assert.equal(r.top.length, 1);
  assert.equal(r.top[0].status, 'NEW');
  assert.equal(r.top[0].employerConfirmed, true);
  assert.match(r.top[0].posted, /today \(employer date/);
  assert.ok(log.every((l) => /myworkdayjobs\.com\/wday\/cxs\//.test(l.url)), 'only the employer endpoint was called');
});
