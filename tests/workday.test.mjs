// Workday employer verification for LinkedIn/Indeed-discovered jobs.
// Mocks only. Each of the five required confirmations is tested failing alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkdayIndex, workdayCandidates, pickUnique, verifyViaWorkday, acronym } from '../src/engine/workday-verify.mjs';
import { employerMatches, levelSignature } from '../src/engine/match.mjs';
import { verifyAtEmployer } from '../src/engine/ats.mjs';
import { runFreshScan } from '../src/engine/run.mjs';
import { classifyFreshness, STATUS } from '../src/engine/freshness.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { applyEmployerFacts } from '../src/engine/run.mjs';
import { NOW, HOUR, DAY, tmpDir, testConfig, deps, freshStore, mockFetch, GOOD_JD } from './helpers.mjs';

const TODAY = new Date(NOW).toISOString().slice(0, 10);
const DATASET = [
  'qualcomm|wd5|external', 'qualcomm|wd5|QualcommInternal',
  'bah|wd1|bah_jobs', 'alignmenthealthcare|wd12|ahc_external',
  'wd5|wd5|junk', 'bad slug|wd1|x', 'umbrella|wd1|careers',
];
const INDEX = buildWorkdayIndex(DATASET, [{ tenant: 'acmecorp', instance: 'wd3', site: 'Ext', company: 'Acme Robotics' }]);

const QC = 'https://qualcomm.wd5.myworkdayjobs.com/wday/cxs/qualcomm/external';
const QC_PATH = '/job/San-Diego/Machine-Learning-Engineer---Agentic-AI_3070123';

const li = (patch = {}) => makeJob({
  source: 'apify-linkedin', sourceJobId: 'li-qc', url: 'https://www.linkedin.com/jobs/view/4468098165',
  company: 'Qualcomm', title: 'Machine Learning Engineer – Agentic AI', location: 'San Diego, CA',
  postedAt: NOW - 44 * 60_000, postedEvidence: EVIDENCE.AGGREGATOR, description: GOOD_JD, ...patch,
});

function wdList(postings) { return { total: postings.length, jobPostings: postings }; }
function posting(patch = {}) {
  return { title: 'Machine Learning Engineer - Agentic AI', externalPath: QC_PATH, locationsText: 'San Diego, California', postedOn: 'Posted Today', bulletFields: ['3070123'], ...patch };
}
function detail(patch = {}, org = 'Qualcomm') {
  return {
    jobPostingInfo: {
      title: 'Machine Learning Engineer - Agentic AI', jobDescription: '<p>Build agentic AI with Python.</p>', startDate: TODAY,
      postedOn: 'Posted Today', jobReqId: '3070123', canApply: true,
      externalUrl: `https://qualcomm.wd5.myworkdayjobs.com/external${QC_PATH}`, ...patch,
    },
    ...(org === null ? {} : { hiringOrganization: { name: org } }),
  };
}
const fj = (routes, log = []) => { const f = mockFetch(routes, log); return async (u, o) => { try { const r = await f(u, o); return r.ok ? r.json() : null; } catch { return null; } }; };
const qcRoutes = ({ list = wdList([posting()]), doc = detail() } = {}) => [
  [/\/wday\/cxs\/qualcomm\/external\/jobs$/, () => list],
  [/\/wday\/cxs\/qualcomm\/external\/job\//, () => doc],
  [/.*/, () => ({ __status: 404 })],
];
async function verifyAndClassify(job, routes, index = INDEX) {
  const { facts, reason } = await verifyViaWorkday(job, { fetchJson: fj(routes), index });
  if (facts) applyEmployerFacts(job, facts);
  return { facts, reason, status: classifyFreshness(job, { strongFirstSeen: null, weakFirstSeen: null }, NOW).status };
}

// ── Tenant list and candidates ───────────────────────────────────────

test('index: reuses the scan-ats-full tenant list; drops junk wdN tenants, internal sites, bad slugs', () => {
  assert.ok(!INDEX.byTenant.has('wd5'));
  assert.ok(!INDEX.byTenant.has('bad slug'));
  assert.deepEqual(INDEX.byTenant.get('qualcomm').map((b) => b.site), ['external']);
});

test('candidates: tracked > exact > prefix > acronym; unknown employer → none', () => {
  assert.equal(workdayCandidates('Acme Robotics', INDEX)[0].via, 'tracked');
  assert.deepEqual(workdayCandidates('Qualcomm', INDEX).map((b) => [b.tenant, b.via]), [['qualcomm', 'exact']]);
  assert.deepEqual(workdayCandidates('Alignment Health', INDEX).map((b) => [b.tenant, b.via]), [['alignmenthealthcare', 'prefix']]);
  assert.equal(acronym('Booz Allen Hamilton'), 'bah');
  assert.deepEqual(workdayCandidates('Booz Allen Hamilton', INDEX).map((b) => [b.tenant, b.via]), [['bah', 'acronym']]);
  assert.deepEqual(workdayCandidates('Kirkland & Ellis', INDEX), []);
});

// ── Matching helpers ─────────────────────────────────────────────────

test('employerMatches: same employer yes; similar-looking different employers no', () => {
  assert.ok(employerMatches('JPMorganChase', 'JPMorgan Chase & Co.'));
  assert.ok(employerMatches('Alignment Health', 'Alignment Healthcare'));
  assert.ok(employerMatches('Booz Allen Hamilton', 'Booz Allen Hamilton Inc.'));
  assert.ok(!employerMatches('American Express', 'American Airlines'));
  assert.ok(!employerMatches('Apple', 'Applied Materials'));
  assert.ok(!employerMatches('Booz Allen Hamilton', 'Bank of America Holdings'));
});

test('levelSignature: seniority and level numbers must agree', () => {
  assert.notEqual(levelSignature('Data Scientist'), levelSignature('Senior Data Scientist'));
  assert.notEqual(levelSignature('Software Engineer II'), levelSignature('Software Engineer III'));
  assert.equal(levelSignature('Sr. Data Scientist'), levelSignature('Senior Data Scientist'));
});

// ── Similar titles ───────────────────────────────────────────────────

const job = (patch) => li({ title: 'Data Scientist', location: 'Austin, TX', requisitionId: '', ...patch });

test('similar titles: same title in two cities → the job’s city wins', () => {
  const { pick } = pickUnique(job(), [
    posting({ title: 'Data Scientist', locationsText: 'Boston, MA', externalPath: '/job/Boston/DS_1', bulletFields: ['R1'] }),
    posting({ title: 'Data Scientist', locationsText: 'Austin, Texas', externalPath: '/job/Austin/DS_2', bulletFields: ['R2'] }),
  ]);
  assert.equal(pick.p.externalPath, '/job/Austin/DS_2');
});

test('similar titles: two equally plausible postings → ambiguous → no match (excluded)', () => {
  const r = pickUnique(job({ location: 'Remote' }), [
    posting({ title: 'Data Scientist', locationsText: 'Remote', externalPath: '/job/Remote/DS_1', bulletFields: ['R1'] }),
    posting({ title: 'Data Scientist', locationsText: 'Remote - US', externalPath: '/job/Remote/DS_2', bulletFields: ['R2'] }),
  ]);
  assert.equal(r.pick, null);
  assert.match(r.reason, /ambiguous/);
});

test('similar titles: a matching requisition id settles it', () => {
  const r = pickUnique(job({ location: 'Remote', requisitionId: 'R2002' }), [
    posting({ title: 'Data Scientist', locationsText: 'Remote', externalPath: '/job/Remote/DS_1', bulletFields: ['R2001'] }),
    posting({ title: 'Data Scientist', locationsText: 'Remote', externalPath: '/job/Remote/DS_2', bulletFields: ['R2002'] }),
  ]);
  assert.equal(r.pick.p.externalPath, '/job/Remote/DS_2');
});

test('similar titles: different seniority, or a different city entirely → no match', () => {
  assert.equal(pickUnique(job(), [posting({ title: 'Senior Data Scientist', locationsText: 'Austin, TX' })]).pick, null);
  assert.equal(pickUnique(job(), [posting({ title: 'Data Scientist II', locationsText: 'Austin, TX' })]).pick, null);
  assert.equal(pickUnique(job(), [posting({ title: 'Data Scientist', locationsText: 'Boston, MA' })]).pick, null);
  assert.equal(pickUnique(job(), [posting({ title: 'Data Analyst', locationsText: 'Austin, TX' })]).pick, null);
});

// ── The five confirmations ───────────────────────────────────────────

test('all five confirmed → NEW, official Workday apply URL, employer date (not LinkedIn time)', async () => {
  const j = li();
  const { facts, status } = await verifyAndClassify(j, qcRoutes());
  assert.equal(status, STATUS.NEW);
  assert.equal(facts.employerUrl, `https://qualcomm.wd5.myworkdayjobs.com/external${QC_PATH}`);
  assert.equal(j.postedEvidence, EVIDENCE.DAY);
  assert.equal(j.postedDay, TODAY);
  assert.equal(j.requisitionId, '3070123');
  assert.match(facts.via, /workday qualcomm\/external \(exact/);
});

test('1 live: canApply:false → closed → excluded', async () => {
  const dir = tmpDir();
  const src = { id: 'apify', async run(ctx) { ctx.emit([li()]); return {}; } };
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch(qcRoutes({ doc: detail({ canApply: false }) })),
    deps: deps(freshStore(dir), [src], { workdayIndex: INDEX }) });
  assert.equal(r.top.length, 0);
  assert.equal(r.counts.excluded['closed at employer'], 1);
});

test('2 employer: acronym tenant whose hiringOrganization is someone else → rejected', async () => {
  const bahRoutes = (org) => [
    [/\/wday\/cxs\/bah\/bah_jobs\/jobs$/, () => wdList([posting({ title: 'Machine Learning Engineer', externalPath: '/job/Arlington/MLE_R1', locationsText: 'Arlington, VA', bulletFields: ['R1'] })])],
    [/\/wday\/cxs\/bah\/bah_jobs\/job\//, () => detail({ title: 'Machine Learning Engineer', externalUrl: 'https://bah.wd1.myworkdayjobs.com/bah_jobs/job/Arlington/MLE_R1' }, org)],
    [/.*/, () => ({ __status: 404 })],
  ];
  const b = (o) => li({ company: 'Booz Allen Hamilton', title: 'Machine Learning Engineer', location: 'Arlington, VA' });
  assert.equal((await verifyAndClassify(b(), bahRoutes('Bank of America Holdings'))).facts, null);
  assert.equal((await verifyAndClassify(b(), bahRoutes(null))).facts, null, 'acronym match without an employer name is not enough');
  const ok = await verifyAndClassify(b(), bahRoutes('Booz Allen Hamilton'));
  assert.equal(ok.status, STATUS.NEW, 'same acronym tenant, employer confirmed by Workday');
});

test('2 employer: exact tenant name is accepted even without hiringOrganization', async () => {
  assert.equal((await verifyAndClassify(li(), qcRoutes({ doc: detail({}, null) }))).status, STATUS.NEW);
});

test('3 role: no close title / ambiguous / detail title differs → rejected', async () => {
  assert.equal((await verifyAndClassify(li(), qcRoutes({ list: wdList([posting({ title: 'Staff Machine Learning Engineer - Agentic AI' })]) }))).facts, null);
  assert.equal((await verifyAndClassify(li(), qcRoutes({ list: wdList([posting(), posting({ externalPath: '/job/San-Diego/MLE_9', bulletFields: ['9'] })]) }))).facts, null);
  assert.equal((await verifyAndClassify(li(), qcRoutes({ doc: detail({ title: 'Finance Manager' }) }))).facts, null);
});

test('4 date: LinkedIn says 44 min ago but Workday startDate is 3 days old → not NEW (repost)', async () => {
  const old = new Date(NOW - 3 * DAY).toISOString().slice(0, 10);
  const r = await verifyAndClassify(li(), qcRoutes({ doc: detail({ startDate: old, postedOn: 'Posted 3 Days Ago' }) }));
  assert.notEqual(r.status, STATUS.NEW);
});

test('4 date: missing or contradicted startDate → not NEW', async () => {
  assert.equal((await verifyAndClassify(li(), qcRoutes({ doc: detail({ startDate: undefined }) }))).status, STATUS.VERIFY);
  assert.equal((await verifyAndClassify(li(), qcRoutes({ doc: detail({ postedOn: 'Posted 30+ Days Ago' }) }))).status, STATUS.VERIFY);
  assert.equal((await verifyAndClassify(li(), qcRoutes({ doc: detail({ startDate: '10/11/2026' }) }))).status, STATUS.VERIFY);
});

test('5 apply URL: never invented — foreign externalUrl ignored, Workday-returned path on the tenant host used', async () => {
  const { facts } = await verifyAndClassify(li(), qcRoutes({ doc: detail({ externalUrl: 'https://evil.example/apply' }) }));
  assert.equal(facts.employerUrl, `https://qualcomm.wd5.myworkdayjobs.com/external${QC_PATH}`);
  assert.equal(new URL(facts.employerUrl).hostname, 'qualcomm.wd5.myworkdayjobs.com');
});

test('Workday endpoint down / no postings / employer not in tenant list → no confirmation', async () => {
  assert.equal((await verifyViaWorkday(li(), { fetchJson: fj([[/.*/, () => ({ __status: 422 })]]), index: INDEX })).facts, null);
  assert.equal((await verifyViaWorkday(li(), { fetchJson: fj(qcRoutes({ list: wdList([]) })), index: INDEX })).facts, null);
  const r = await verifyViaWorkday(li({ company: 'Kirkland & Ellis' }), { fetchJson: fj([]), index: INDEX });
  assert.equal(r.facts, null);
  assert.match(r.reason, /not found in the Workday tenant list/);
});

test('direct Workday link (Indeed jobUrl): employer or seniority mismatch → not verified', async () => {
  const link = 'https://umbrella.wd1.myworkdayjobs.com/careers/job/Remote/Data-Scientist_R5';
  const base = makeJob({ source: 'apify-indeed', sourceJobId: 'k', url: 'https://www.indeed.com/viewjob?jk=k', employerUrl: link, company: 'Umbrella Health', title: 'Data Scientist', location: 'Remote', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR });
  const docFor = (title, org) => fj([[/wday\/cxs/, () => detail({ title, externalUrl: link }, org)]]);
  assert.equal((await verifyAtEmployer(base, { fetchJson: docFor('Data Scientist', 'Umbrella Health'), boardCache: new Map() })).live, true);
  assert.equal((await verifyAtEmployer(base, { fetchJson: docFor('Data Scientist', 'Wayne Enterprises'), boardCache: new Map() })).live, false);
  assert.equal((await verifyAtEmployer(base, { fetchJson: docFor('Senior Data Scientist', 'Umbrella Health'), boardCache: new Map() })).live, false);
});

test('end-to-end: LinkedIn-only job becomes a final result only via full Workday confirmation', async () => {
  const dir = tmpDir();
  const log = [];
  const src = { id: 'apify', async run(ctx) { ctx.emit([li(), li({ sourceJobId: 'li-x', url: 'https://www.linkedin.com/jobs/view/1', company: 'Kirkland & Ellis', title: 'AI Engineer II', location: 'Houston, TX' })]); return {}; } };
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, fetchImpl: mockFetch(qcRoutes(), log),
    deps: deps(freshStore(dir), [src], { workdayIndex: INDEX }) });
  assert.equal(r.top.length, 1);
  assert.equal(r.top[0].company, 'Qualcomm');
  assert.equal(r.top[0].applyUrl, `https://qualcomm.wd5.myworkdayjobs.com/external${QC_PATH}`);
  assert.match(r.top[0].posted, /today \(employer date/);
  assert.equal(r.counts.excluded['original freshness unverifiable'], 1, 'Kirkland & Ellis: not verifiable → excluded');
  assert.ok(log.every((l) => /qualcomm\.wd5\.myworkdayjobs\.com|greenhouse|lever|ashby/.test(l.url)), 'only employer endpoints called');
});
