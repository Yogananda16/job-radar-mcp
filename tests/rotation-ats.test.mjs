import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRotationList, pickBatch } from '../src/engine/sources/ats-rotation.mjs';
import { verifyAtEmployer, parseAtsUrl, fetchAtsPosting, titleSimilarity } from '../src/engine/ats.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { mockFetch, NOW } from './helpers.mjs';

test('rotation list interleaves vendors and excludes tracked boards', () => {
  const list = buildRotationList({ greenhouse: ['b', 'a', 'tracked'], lever: ['x'], ashby: ['m', 'n'] }, new Set(['greenhouse:tracked']));
  assert.deepEqual(list, ['greenhouse:a', 'lever:x', 'ashby:m', 'greenhouse:b', 'ashby:n']);
});

test('rotation: 1–25, 26–50, …, then wraps around', () => {
  const list = Array.from({ length: 60 }, (_, i) => `greenhouse:b${String(i).padStart(2, '0')}`);
  const a = pickBatch(list, {}, 25);
  assert.equal(a.batch[0], list[0]); assert.equal(a.batch.length, 25); assert.equal(a.next.cursor, 25);
  const b = pickBatch(list, a.next, 25);
  assert.equal(b.batch[0], list[25]); assert.equal(b.next.cursor, 50);
  const c = pickBatch(list, b.next, 25);
  assert.deepEqual(c.batch.slice(0, 10), list.slice(50, 60));
  assert.equal(c.batch[10], list[0], 'wraps');
  assert.equal(c.next.cursor, 15);
});

test('rotation: unfinished boards are retried first, batch size still capped', () => {
  const list = Array.from({ length: 60 }, (_, i) => `lever:b${i}`);
  const r = pickBatch(list, { cursor: 25, retry: ['lever:b3', 'lever:b4', 'gone:x'] }, 25);
  assert.deepEqual(r.batch.slice(0, 2), ['lever:b3', 'lever:b4']);
  assert.equal(r.batch.length, 25);
  assert.equal(r.next.cursor, 48);
});

test('rotation: cursor survives a shrunken list', () => {
  const r = pickBatch(['greenhouse:a', 'greenhouse:b'], { cursor: 99 }, 25);
  assert.equal(r.batch.length, 2);
});

test('parseAtsUrl recognises Greenhouse / Lever / Ashby postings', () => {
  assert.deepEqual(parseAtsUrl('https://job-boards.greenhouse.io/acme/jobs/123'), { ats: 'greenhouse', slug: 'acme', id: '123' });
  assert.equal(parseAtsUrl('https://jobs.lever.co/acme/0b6c7e8a-1111-2222-3333-444455556666').ats, 'lever');
  assert.equal(parseAtsUrl('https://www.linkedin.com/jobs/view/1'), null);
});

test('fetchAtsPosting: Greenhouse first_published is the original posting time', async () => {
  const fj = async () => ({ first_published: '2026-10-11T12:00:00Z', content: '&lt;p&gt;Hello&lt;/p&gt;', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123' });
  const r = await fetchAtsPosting('https://job-boards.greenhouse.io/acme/jobs/123', fj);
  assert.equal(r.evidence, EVIDENCE.ATS);
  assert.equal(r.postedAt, Date.parse('2026-10-11T12:00:00Z'));
  assert.equal(r.description, 'Hello');
});

const liJob = (patch = {}) => makeJob({
  source: 'apify-linkedin', sourceJobId: '1', url: 'https://www.linkedin.com/jobs/view/1',
  company: 'Globex Corp', title: 'Senior AI Engineer', location: 'New York, NY', postedAt: NOW - 3_600_000, postedEvidence: EVIDENCE.AGGREGATOR, ...patch,
});

test('verify: LinkedIn job found on the employer Greenhouse board → employer URL + ATS date', async () => {
  const fetchImpl = mockFetch([
    [/boards-api\.greenhouse\.io\/v1\/boards\/globex\/jobs$/, () => ({ jobs: [
      { title: 'Senior AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/globex/jobs/9', location: { name: 'New York, NY' }, first_published: '2026-10-11T13:00:00Z' },
      { title: 'Office Manager', absolute_url: 'https://job-boards.greenhouse.io/globex/jobs/8', location: { name: 'NY' }, first_published: '2026-01-01T00:00:00Z' },
    ] })],
    [/.*/, () => ({ __status: 404 })],
  ]);
  const fetchJson = async (u) => { const r = await fetchImpl(u); return r.ok ? r.json() : null; };
  const v = await verifyAtEmployer(liJob(), { fetchJson, boardCache: new Map() });
  assert.equal(v.employerUrl, 'https://job-boards.greenhouse.io/globex/jobs/9');
  assert.equal(v.evidence, EVIDENCE.ATS);
  assert.equal(v.postedAt, Date.parse('2026-10-11T13:00:00Z'));
});

test('verify: not found at the employer → null (job stays VERIFY)', async () => {
  const fetchJson = async () => null;
  assert.equal(await verifyAtEmployer(liJob(), { fetchJson, boardCache: new Map() }), null);
});

test('verify: employer apply link without a known ATS → confirmed URL but no date', async () => {
  const v = await verifyAtEmployer(liJob({ employerUrl: 'https://careers.globex.com/jobs/9' }), { fetchJson: async () => null, boardCache: new Map() });
  assert.equal(v.employerUrl, 'https://careers.globex.com/jobs/9');
  assert.equal(v.evidence, EVIDENCE.NONE);
});

test('titleSimilarity: same role matches, different role does not', () => {
  assert.ok(titleSimilarity('Senior AI Engineer', 'Senior AI Engineer (Remote)') >= 0.75);
  assert.ok(titleSimilarity('Senior AI Engineer', 'Office Manager') < 0.75);
});
