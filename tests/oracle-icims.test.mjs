// Oracle Recruiting Cloud + iCIMS employer verification. Mocks only; fixture
// shapes follow the real JPMC/Uber Oracle API responses seen 2026-10-12/13 and
// the iCIMS markup providers/icims.mjs parses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOracleJobUrl, fetchOraclePosting, parseIcimsJobUrl, fetchIcimsPosting, classifyIsoDate } from '../src/engine/ats-extra.mjs';
import { verifyViaOracle, verifyViaIcims, oracleSitesFor, buildIcimsIndex } from '../src/engine/oracle-icims-verify.mjs';
import { verifyAtEmployer, employerAtsKind } from '../src/engine/ats.mjs';
import { runFreshScan, applyEmployerFacts } from '../src/engine/run.mjs';
import { classifyFreshness, STATUS } from '../src/engine/freshness.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { NOW, HOUR, DAY, tmpDir, testConfig, deps, freshStore, mockFetch, GOOD_JD } from './helpers.mjs';

const JPMC = 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/job/210794583';
const UBER = 'https://iaziqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/UberCareers/job/302494';
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');

function oracleDetail(patch = {}) {
  return { items: [{ Id: '210794583', Title: 'Senior Associate-Applied Artificial Intelligence / Machine Learning',
    ExternalPostedStartDate: iso(NOW - 3 * HOUR), PrimaryLocation: 'Palo Alto, CA, United States', secondaryLocations: [],
    ExternalDescriptionStr: '<p>Build GenAI and ML applications with Python, PyTorch and LangChain.</p>', ...patch }], count: 1 };
}
function oracleSearch(reqs) {
  return { items: [{ SiteNumber: 'CX_2001', TotalJobsCount: reqs.length, requisitionList: reqs }] };
}
const req = (patch = {}) => ({ Id: '210794583', Title: 'Senior Associate-Applied Artificial Intelligence / Machine Learning', PrimaryLocation: 'Palo Alto, CA, United States', PostedDate: '2026-10-11', ...patch });
const fj = (routes, log = []) => { const f = mockFetch(routes, log); return async (u, o) => { try { const r = await f(u, o); return r.ok ? r.json() : null; } catch { return null; } }; };
const ft = (routes, log = []) => async (u) => { log.push(u); for (const [re, body] of routes) if (re.test(u)) return typeof body === 'function' ? body(u) : body; return null; };

// ── Oracle ───────────────────────────────────────────────────────────

test('oracle: URL parsing for JPMC and Uber hosts; others → null', () => {
  assert.deepEqual(parseOracleJobUrl(JPMC), { host: 'jpmc.fa.oraclecloud.com', lang: 'en', siteNumber: 'CX_2001', locationId: null, id: '210794583' });
  assert.equal(parseOracleJobUrl(UBER).siteNumber, 'UberCareers');
  assert.equal(parseOracleJobUrl('https://evil.example/hcmUI/CandidateExperience/en/sites/X/job/1'), null);
  assert.equal(employerAtsKind(JPMC), 'oracle');
});

test('iso dates: exact with offset → employer timestamp; bare date → day-only; else unusable', () => {
  assert.equal(classifyIsoDate('2026-10-12T13:32:37+00:00').evidence, EVIDENCE.ATS);
  assert.equal(classifyIsoDate('2026-10-12').evidence, EVIDENCE.DAY);
  assert.equal(classifyIsoDate('10/12/2026'), null);
  assert.equal(classifyIsoDate('2026-10-12T13:32:37'), null, 'no offset → ambiguous');
});

test('oracle posting: live with exact date and canonical apply URL; removed → null; past end date → closed', async () => {
  const p = await fetchOraclePosting(JPMC, fj([[/recruitingCEJobRequisitionDetails/, () => oracleDetail()]]), NOW);
  assert.equal(p.evidence, EVIDENCE.ATS);
  assert.equal(p.live, true);
  assert.equal(p.employerUrl, JPMC);
  assert.match(p.description, /LangChain/);
  assert.equal(await fetchOraclePosting(JPMC, fj([[/Details/, () => ({ items: [], count: 0 })]]), NOW), null, 'the closed JPMC 210797699 case');
  const ended = await fetchOraclePosting(JPMC, fj([[/Details/, () => oracleDetail({ ExternalPostedEndDate: iso(NOW - DAY) })]]), NOW);
  assert.equal(ended.closed, true);
});

const CONFIG_BOARDS = { JPMorganChase: [{ careers_url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/jobs' }] };
const li = (patch = {}) => makeJob({ source: 'apify-linkedin', sourceJobId: 'li-j', url: 'https://www.linkedin.com/jobs/view/1', company: 'JPMorgan Chase & Co.',
  title: 'Senior Associate - Applied Artificial Intelligence / Machine Learning', location: 'Palo Alto, CA', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR, description: GOOD_JD, ...patch });

test('oracle sites: only those tied to the employer in config or the tracked list', () => {
  assert.equal(oracleSitesFor('JPMorgan Chase & Co.', { companyBoards: CONFIG_BOARDS }).length, 1);
  assert.equal(oracleSitesFor('Uber', { companyBoards: CONFIG_BOARDS }).length, 0);
  assert.equal(oracleSitesFor('Uber', { trackedCompanies: [{ name: 'Uber', careers_url: 'https://iaziqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/UberCareers/jobs' }] })[0].via, 'tracked');
});

test('oracle lookup: LinkedIn JPMC job found on JPMC Oracle → NEW with the official Oracle URL', async () => {
  const fetchJson = fj([[/recruitingCEJobRequisitions\?/, () => oracleSearch([req(), req({ Id: '210700001', Title: 'Software Engineer III', PrimaryLocation: 'Plano, TX' })])],
    [/recruitingCEJobRequisitionDetails/, () => oracleDetail()]]);
  const job = li();
  const { facts } = await verifyViaOracle(job, { fetchJson, companyBoards: CONFIG_BOARDS, now: NOW });
  applyEmployerFacts(job, facts);
  assert.equal(classifyFreshness(job, { strongFirstSeen: null, weakFirstSeen: null }, NOW).status, STATUS.NEW);
  assert.equal(job.employerUrl, JPMC);
  assert.equal(job.liveVerified, true);
});

test('oracle lookup: no configured site / ambiguous / removed → no confirmation', async () => {
  assert.match((await verifyViaOracle(li({ company: 'Kirkland & Ellis' }), { fetchJson: fj([]), companyBoards: CONFIG_BOARDS })).reason, /no Oracle site configured/);
  const twins = oracleSearch([req({ PrimaryLocation: 'Remote' }), req({ Id: '210700002', PrimaryLocation: 'Remote - US' })]);
  assert.equal((await verifyViaOracle(li({ location: 'Remote' }), { fetchJson: fj([[/Requisitions\?/, () => twins]]), companyBoards: CONFIG_BOARDS })).facts, null);
  const gone = fj([[/Requisitions\?/, () => oracleSearch([req()])], [/Details/, () => ({ items: [] })]]);
  assert.equal((await verifyViaOracle(li(), { fetchJson: gone, companyBoards: CONFIG_BOARDS })).facts, null);
});

test('oracle: an old employer date with a fresh LinkedIn time → POSSIBLE_REPOST, not NEW', async () => {
  const fetchJson = fj([[/Requisitions\?/, () => oracleSearch([req()])], [/Details/, () => oracleDetail({ ExternalPostedStartDate: iso(NOW - 9 * DAY) })]]);
  const job = li();
  applyEmployerFacts(job, (await verifyViaOracle(job, { fetchJson, companyBoards: CONFIG_BOARDS, now: NOW })).facts);
  assert.equal(classifyFreshness(job, { strongFirstSeen: null, weakFirstSeen: null }, NOW).status, STATUS.POSSIBLE_REPOST);
});

// ── iCIMS ────────────────────────────────────────────────────────────

const ORIGIN = 'https://careers-hartfordhealthcare.icims.com';
const card = (id, title, loc) => `<li class="iCIMS_JobCardItem"><a class="iCIMS_Anchor" href="${ORIGIN}/jobs/${id}/${title.toLowerCase().replace(/\W+/g, '-')}/job?in_iframe=1"><h3>${title}</h3></a>`
  + `<span class="field-label">Location</span><span>${loc}</span></li>`;
const postingHtml = (patch = {}) => `<html><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting',
  title: 'Data Scientist', datePosted: iso(NOW - 2 * HOUR), validThrough: iso(NOW + 30 * DAY), description: '<p>Python, SQL, machine learning.</p>',
  hiringOrganization: { '@type': 'Organization', name: 'Hartford HealthCare' }, identifier: { '@type': 'PropertyValue', value: '12345' }, ...patch })}</script></html>`;
const ict = (job) => makeJob({ source: 'apify-indeed', sourceJobId: 'k1', url: 'https://www.indeed.com/viewjob?jk=k1', company: 'Hartford HealthCare',
  title: 'Data Scientist', location: 'Hartford, CT', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR, ...job });
const INDEX = buildIcimsIndex(['hartfordhealthcare', 'acme']);

test('icims: URL parsing; posting JSON-LD → exact date, org, open status; no JSON-LD → null', async () => {
  assert.deepEqual(parseIcimsJobUrl(`${ORIGIN}/jobs/12345/data-scientist/job?mode=view`), { origin: ORIGIN, id: '12345' });
  assert.equal(parseIcimsJobUrl('https://example.com/jobs/1/x/job'), null);
  const p = await fetchIcimsPosting(`${ORIGIN}/jobs/12345/data-scientist/job`, ft([[/\/jobs\/12345\/job/, postingHtml()]]), NOW);
  assert.equal(p.evidence, EVIDENCE.ATS);
  assert.equal(p.org, 'Hartford HealthCare');
  assert.equal(p.live, true);
  assert.equal(p.employerUrl, `${ORIGIN}/jobs/12345/job`);
  assert.equal((await fetchIcimsPosting(`${ORIGIN}/jobs/12345/x/job`, ft([[/./, postingHtml({ datePosted: '2026-10-11' })]]), NOW)).evidence, EVIDENCE.DAY);
  assert.equal((await fetchIcimsPosting(`${ORIGIN}/jobs/12345/x/job`, ft([[/./, postingHtml({ validThrough: iso(NOW - DAY) })]]), NOW)).closed, true);
  assert.equal(await fetchIcimsPosting(`${ORIGIN}/jobs/12345/x/job`, ft([[/./, '<html>no data</html>']]), NOW), null);
});

test('icims lookup: exact tenant → search → posting; employer confirmed by hiringOrganization → NEW', async () => {
  const fetchText = ft([[/\/jobs\/search/, card(12345, 'Data Scientist', 'US-CT-Hartford') + card(12399, 'Nurse Manager', 'US-CT-Hartford')],
    [/\/jobs\/12345\/job/, postingHtml()]]);
  const job = ict();
  const { facts, reason } = await verifyViaIcims(job, { fetchText, index: buildIcimsIndex(['hartfordhealthcare']), now: NOW });
  assert.ok(facts, reason);
  applyEmployerFacts(job, facts);
  assert.equal(classifyFreshness(job, { strongFirstSeen: null, weakFirstSeen: null }, NOW).status, STATUS.NEW);
  assert.equal(job.employerUrl, `${ORIGIN}/jobs/12345/job`);
});

test('icims lookup: hiringOrganization missing or different → rejected; tenant not in list → none', async () => {
  const search = [/\/jobs\/search/, card(12345, 'Data Scientist', 'US-CT-Hartford')];
  for (const html of [postingHtml({ hiringOrganization: undefined }), postingHtml({ hiringOrganization: { name: 'Hartford Steam Boiler' } })]) {
    const r = await verifyViaIcims(ict(), { fetchText: ft([search, [/\/jobs\/12345\/job/, html]]), index: buildIcimsIndex(['hartfordhealthcare']), now: NOW });
    assert.equal(r.facts, null, r.reason);
  }
  assert.match((await verifyViaIcims(ict({ company: 'Unknown Co' }), { fetchText: ft([]), index: INDEX })).reason, /not found in the iCIMS tenant list/);
});

test('direct links: an Indeed employer link to Oracle or iCIMS is verified on that posting', async () => {
  const viaOracle = await verifyAtEmployer(li({ employerUrl: JPMC }), { fetchJson: fj([[/Details/, () => oracleDetail()]]), boardCache: new Map() });
  assert.equal(viaOracle.live, true);
  assert.equal(viaOracle.evidence, EVIDENCE.ATS);
  const icUrl = `${ORIGIN}/jobs/12345/data-scientist/job`;
  const viaIcims = await verifyAtEmployer(ict({ employerUrl: icUrl }), { fetchJson: fj([]), fetchText: ft([[/\/jobs\/12345\/job/, postingHtml()]]), boardCache: new Map() });
  assert.equal(viaIcims.live, true);
  const wrongOrg = await verifyAtEmployer(ict({ employerUrl: icUrl }), { fetchJson: fj([]), fetchText: ft([[/./, postingHtml({ hiringOrganization: { name: 'Wayne Enterprises' } })]]), boardCache: new Map() });
  assert.equal(wrongOrg.live, false, 'employer named on the posting must match');
});

test('end-to-end: a LinkedIn JPMC job reaches the results only through Oracle confirmation', async () => {
  const dir = tmpDir();
  const config = testConfig(dir);
  config.companyBoards = CONFIG_BOARDS;
  const src = { id: 'apify', async run(ctx) { ctx.emit([li(), li({ sourceJobId: 'x', url: 'https://www.linkedin.com/jobs/view/2', company: 'Kirkland & Ellis', title: 'AI Engineer II', location: 'Houston, TX' })]); return {}; } };
  const r = await runFreshScan({ config, now: NOW, persist: false, deps: deps(freshStore(dir), [src]),
    fetchImpl: mockFetch([[/recruitingCEJobRequisitions\?/, () => oracleSearch([req()])], [/recruitingCEJobRequisitionDetails/, () => oracleDetail()], [/.*/, () => ({ __status: 404 })]]) });
  assert.deepEqual(r.top.map((t) => t.company), ['JPMorgan Chase & Co.']);
  assert.equal(r.top[0].applyUrl, JPMC);
  assert.match(r.top[0].liveVia, /oracle jpmc\.fa\.oraclecloud\.com\/CX_2001 \(configured/);
  assert.equal(r.counts.excluded['original freshness unverifiable'], 1);
});
