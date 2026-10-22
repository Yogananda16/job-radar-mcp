// Public job boards (RemoteOK, Built In, The Muse, …): discovery-only
// aggregators. Mocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerJobToJob, runBoards } from '../src/engine/boards.mjs';
import { publicBoardEntries } from '../src/engine/sources/tracked.mjs';
import { isEmployerUrl, EVIDENCE } from '../src/engine/job.mjs';
import { DEFAULTS, loadConfigForPreset } from '../src/engine/config.mjs';
import { parseCli } from '../src/engine/cli.mjs';
import { runFreshScan } from '../src/engine/run.mjs';
import { NOW, HOUR, tmpDir, testConfig, deps, freshStore, mockFetch, GOOD_JD } from './helpers.mjs';

const boardJob = (patch = {}) => ({ title: 'Machine Learning Engineer', url: 'https://remoteok.com/remote-jobs/123-ml-engineer', company: 'Globex',
  location: 'Remote - US', postedAt: NOW - HOUR, description: GOOD_JD, ...patch });

test('board job: aggregator evidence, never live, board page is not an employer link', () => {
  const j = providerJobToJob(boardJob(), { providerId: 'remoteok', entryName: 'RemoteOK', source: 'tracked', aggregator: true });
  assert.equal(j.postedEvidence, EVIDENCE.AGGREGATOR);
  assert.equal(j.liveVerified, false);
  assert.equal(j.employerUrl, '');
  assert.equal(j.source, 'board:remoteok');
});

test('board job linking straight to an employer ATS posting keeps that as the employer link (still unverified)', () => {
  const j = providerJobToJob(boardJob({ url: 'https://job-boards.greenhouse.io/globex/jobs/77' }), { providerId: 'himalayas', entryName: 'Himalayas', source: 'tracked', aggregator: true });
  assert.equal(j.employerUrl, 'https://job-boards.greenhouse.io/globex/jobs/77');
  assert.equal(j.liveVerified, false);
});

test('a board’s own name is never used as the employer', () => {
  assert.equal(providerJobToJob(boardJob({ company: 'RemoteOK' }), { providerId: 'remoteok', entryName: 'RemoteOK', source: 'tracked', aggregator: true }).company, '');
});

test('board hosts are never "employer" links', () => {
  for (const u of ['https://remoteok.com/x', 'https://remotive.com/x', 'https://himalayas.app/x', 'https://builtin.com/job/x', 'https://www.builtinnyc.com/job/x',
    'https://www.themuse.com/jobs/x', 'https://news.ycombinator.com/item?id=1', 'https://weworkremotely.com/x', 'https://joinhandshake.com/x']) {
    assert.equal(isEmployerUrl(u), false, u);
  }
  assert.equal(isEmployerUrl('https://job-boards.greenhouse.io/acme/jobs/1'), true);
});

test('public board list: 14 US boards, Built In by category only (robots.txt disallows ?search=)', () => {
  assert.equal(DEFAULTS.publicBoards.length, 14);
  const bi = DEFAULTS.publicBoards.find((b) => b.provider === 'builtin');
  assert.ok(bi.builtin.categories.length && !bi.builtin.queries);
  for (const banned of ['echojobs', 'handshake', 'telegram-channel']) assert.ok(!DEFAULTS.publicBoards.some((b) => b.provider === banned), banned);
});

test('publicBoardEntries marks boards as aggregators and skips unknown providers', () => {
  const providers = new Map([['remoteok', { id: 'remoteok' }]]);
  const { boards, skipped } = publicBoardEntries([{ name: 'RemoteOK', provider: 'remoteok' }, { name: 'Nope', provider: 'nope' }], providers);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].aggregator, true);
  assert.deepEqual(skipped, ['Nope']);
});

test('runBoards maps aggregator boards as discovery-only', async () => {
  const emitted = [];
  await runBoards([{ entry: { name: 'RemoteOK' }, provider: { id: 'remoteok', fetch: async () => [boardJob()] }, key: 'board:RemoteOK', aggregator: true }],
    { signal: new AbortController().signal, emit: (j) => emitted.push(...j), source: 'tracked', perBoardMs: 1000, concurrency: 1, httpCtx: {} });
  assert.equal(emitted[0].postedEvidence, EVIDENCE.AGGREGATOR);
  assert.equal(emitted[0].liveVerified, false);
});

const src = (jobs) => ({ id: 'tracked', async run(ctx) { ctx.emit(jobs); return {}; } });
const asBoard = (patch) => providerJobToJob(boardJob(patch), { providerId: 'remoteok', entryName: 'RemoteOK', source: 'tracked', aggregator: true });

test('strict gate: an unverified board job is excluded; a board job confirmed on the employer ATS becomes NEW with the official link', async () => {
  const dir = tmpDir();
  const r = await runFreshScan({ config: testConfig(dir), now: NOW, persist: false, deps: deps(freshStore(dir), [src([asBoard({ company: 'Initech', url: 'https://remoteok.com/remote-jobs/456-ml-engineer' }), asBoard()])]),
    fetchImpl: mockFetch([
      [/boards-api\.greenhouse\.io\/v1\/boards\/globex\/jobs$/, () => ({ jobs: [{ title: 'Machine Learning Engineer', absolute_url: 'https://job-boards.greenhouse.io/globex/jobs/9', location: { name: 'Remote - US' }, first_published: new Date(NOW - 2 * HOUR).toISOString() }] })],
      [/.*/, () => ({ __status: 404 })],
    ]) });
  assert.deepEqual(r.top.map((t) => t.company), ['Globex']);
  assert.equal(r.top[0].applyUrl, 'https://job-boards.greenhouse.io/globex/jobs/9');
  assert.match(r.top[0].discoveredOn, /board:remoteok/);
  assert.equal(r.counts.excluded['original freshness unverifiable'], 1, 'Initech: not confirmable → excluded');
});

test('--rotation-batch=N works for one run and is still clamped to 50', () => {
  const dir = tmpDir();
  assert.equal(parseCli(['run', '--rotation-batch=50']).overrides.rotationBatch, 50);
  assert.deepEqual(parseCli(['--rotation-batch=50']).unknown, []);
  assert.equal(loadConfigForPreset('run', { rotationBatch: 500 }, { root: dir }).rotationBatch, 50);
});

test('public boards are off for company presets and startup', () => {
  const dir = tmpDir();
  assert.equal(loadConfigForPreset('faang', {}, { root: dir }).sources.tracked, false);
  const st = loadConfigForPreset('startup', {}, { root: dir });
  assert.equal(st.trackedCategory, 'startup'); // tracked worker skips public boards when a category is set
});
