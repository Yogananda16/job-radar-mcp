import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoards, providerJobToJob } from '../src/engine/boards.mjs';
import { trackedBoards } from '../src/engine/sources/tracked.mjs';
import { EVIDENCE } from '../src/engine/job.mjs';

const fast = { id: 'greenhouse', fetch: async (e) => [{ title: 'Data Scientist', url: `https://job-boards.greenhouse.io/${e.name}/jobs/1`, postedAt: Date.now() }] };
const hang = { id: 'workday', fetch: () => new Promise(() => {}) };
const boom = { id: 'lever', fetch: async () => { throw new Error('HTTP 500'); } };

test('runBoards: streams results per board; a hung board times out; errors are isolated', async () => {
  const emitted = [];
  const r = await runBoards([
    { entry: { name: 'a' }, provider: fast, key: 'a' },
    { entry: { name: 'b' }, provider: hang, key: 'b' },
    { entry: { name: 'c' }, provider: boom, key: 'c' },
  ], { signal: new AbortController().signal, emit: (j) => emitted.push(...j), source: 'tracked', perBoardMs: 100, concurrency: 3, httpCtx: {} });
  assert.deepEqual(r.done, ['a']);
  assert.deepEqual(r.failed.sort(), ['b', 'c']);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].postedEvidence, EVIDENCE.ATS);
});

test('runBoards: stop signal → remaining boards are "unfinished" (retried next rotation), not failed', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort('budget'), 50);
  const boards = Array.from({ length: 5 }, (_, i) => ({ entry: { name: `h${i}` }, provider: hang, key: `h${i}` }));
  const t0 = Date.now();
  const r = await runBoards(boards, { signal: stop.signal, emit: () => {}, source: 'ats-rotation', perBoardMs: 10_000, concurrency: 2, httpCtx: {} });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.failed.length, 0);
  assert.equal(r.unfinished.length, 5);
});

test('non-ATS providers get day-only evidence (must be today), ATS providers exact', () => {
  const base = { title: 'x', url: 'https://x.example/1', postedAt: Date.now() };
  assert.equal(providerJobToJob(base, { providerId: 'workday', entryName: 'W', source: 'tracked' }).postedEvidence, EVIDENCE.DAY);
  assert.equal(providerJobToJob(base, { providerId: 'ashby', entryName: 'A', source: 'tracked' }).postedEvidence, EVIDENCE.ATS);
});

test('tracked: websearch-only and provider-less entries are skipped, not scanned', () => {
  const providers = new Map([['greenhouse', { id: 'greenhouse', detect: (e) => /greenhouse/.test(e.careers_url) }]]);
  const { boards, skipped } = trackedBoards({ tracked_companies: [
    { name: 'GH', careers_url: 'https://job-boards.greenhouse.io/gh' },
    { name: 'WS', careers_url: 'https://ws.example/careers', scan_method: 'websearch' },
    { name: 'Off', careers_url: 'https://job-boards.greenhouse.io/off', enabled: false },
    { name: 'Unknown', careers_url: 'https://unknown.example/jobs' },
  ] }, providers);
  assert.deepEqual(boards.map((b) => b.entry.name), ['GH']);
  assert.deepEqual(skipped.sort(), ['Unknown', 'WS']);
});
