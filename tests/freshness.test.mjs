import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness, freshnessAllowsTop, STATUS } from '../src/engine/freshness.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { SeenStore, historyRecords } from '../src/engine/seen-store.mjs';
import { NOW, HOUR, DAY, atsJob, tmpDir, GOOD_JD } from './helpers.mjs';
import path from 'path';

const none = { strongFirstSeen: null, weakFirstSeen: null };
const li = (patch = {}) => makeJob({
  source: 'apify-linkedin', sourceJobId: '4001', url: 'https://www.linkedin.com/jobs/view/4001',
  company: 'Globex', title: 'AI Engineer', location: 'Remote', postedAt: NOW - HOUR, postedEvidence: EVIDENCE.AGGREGATOR, ...patch,
});

test('employer ATS time within 24h, never seen → NEW', () => {
  const f = classifyFreshness(atsJob(1), none, NOW);
  assert.equal(f.status, STATUS.NEW);
  assert.ok(freshnessAllowsTop(f));
});

test('aggregator time alone is never NEW → VERIFY', () => {
  const f = classifyFreshness(li(), none, NOW);
  assert.equal(f.status, STATUS.VERIFY);
  assert.equal(f.freshSignal, 'aggregator');
});

test('missing postedAt → VERIFY and not eligible for Top 10', () => {
  const f = classifyFreshness(atsJob(1, { postedAt: null }), none, NOW);
  assert.equal(f.status, STATUS.VERIFY);
  assert.equal(f.freshSignal, 'none');
  assert.equal(freshnessAllowsTop(f), false);
});

test('"first seen by Career Ops today" alone is not proof → VERIFY, not NEW', () => {
  const job = atsJob(1, { postedAt: null });
  const f = classifyFreshness(job, { strongFirstSeen: NOW - HOUR, weakFirstSeen: null }, NOW);
  assert.notEqual(f.status, STATUS.NEW);
  assert.equal(f.status, STATUS.VERIFY);
});

test('LinkedIn refresh: job first seen 3 days ago shows "1 hour ago" → SEEN, not fresh', () => {
  const f = classifyFreshness(li(), { strongFirstSeen: NOW - 3 * DAY, weakFirstSeen: null }, NOW);
  assert.equal(f.status, STATUS.SEEN);
  assert.equal(f.fresh, false);
  assert.equal(freshnessAllowsTop(f), false);
});

test('employer says 10 days old but listing shows fresh → POSSIBLE_REPOST', () => {
  const job = { ...atsJob(1, { postedAt: NOW - 10 * DAY }), listedAt: NOW - HOUR };
  const f = classifyFreshness(job, none, NOW);
  assert.equal(f.status, STATUS.POSSIBLE_REPOST);
});

test('new id, same company/title/location first seen 5 days ago → POSSIBLE_REPOST', () => {
  const f = classifyFreshness(atsJob(1), { strongFirstSeen: null, weakFirstSeen: NOW - 5 * DAY }, NOW);
  assert.equal(f.status, STATUS.POSSIBLE_REPOST);
});

test('employer time older than 24h → STALE', () => {
  assert.equal(classifyFreshness(atsJob(1, { postedAt: NOW - 30 * HOUR }), none, NOW).status, STATUS.STALE);
});

test('day-only employer date counts only if it is today', () => {
  const today = new Date(NOW); today.setHours(0, 0, 0, 0);
  const yesterday = today.getTime() - DAY;
  assert.equal(classifyFreshness(atsJob(1, { postedAt: today.getTime(), postedEvidence: EVIDENCE.DAY }), none, NOW).status, STATUS.NEW);
  assert.equal(classifyFreshness(atsJob(1, { postedAt: yesterday, postedEvidence: EVIDENCE.DAY }), none, NOW).status, STATUS.STALE);
});

test('already shown earlier today → SEEN, and SEEN is never allowed in final results (strict rule)', () => {
  const f = classifyFreshness(atsJob(1, { postedAt: NOW - 5 * HOUR }), { strongFirstSeen: NOW - 3 * HOUR, weakFirstSeen: null }, NOW);
  assert.equal(f.status, STATUS.SEEN);
  assert.equal(freshnessAllowsTop(f), false);
});

test('aggregator listing older than 24h → STALE', () => {
  assert.equal(classifyFreshness(li({ postedAt: NOW - 3 * DAY }), none, NOW).status, STATUS.STALE);
});

// ── SeenStore ──

test('store: refresh with same LinkedIn id keeps original firstSeen across reloads', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'seen.json');
  const s1 = new SeenStore({ file });
  s1.upsert(li(), NOW - 3 * DAY);
  s1.save(NOW - 3 * DAY);
  const s2 = SeenStore.load(file);
  const refreshed = li({ postedAt: NOW - 10 * 60_000 });
  const look = s2.lookup(refreshed);
  assert.equal(look.strongFirstSeen, NOW - 3 * DAY);
  s2.upsert(refreshed, NOW);
  assert.equal(s2.lookup(refreshed).strongFirstSeen, NOW - 3 * DAY, 'firstSeen never moves forward');
  assert.equal(classifyFreshness(refreshed, s2.lookup(refreshed), NOW).status, STATUS.SEEN);
});

test('store: repost with new id + new URL is caught by company/title/location', () => {
  const s = new SeenStore({});
  s.upsert(li(), NOW - 4 * DAY);
  const repost = li({ sourceJobId: '9999', url: 'https://www.linkedin.com/jobs/view/9999' });
  const look = s.lookup(repost);
  assert.equal(look.strong.length, 0);
  assert.equal(look.weakFirstSeen, NOW - 4 * DAY);
  assert.equal(classifyFreshness(repost, look, NOW).status, STATUS.POSSIBLE_REPOST);
});

test('store: repost with a new title/location but the same job text is caught by fingerprint', () => {
  const s = new SeenStore({});
  s.upsert(atsJob(1, { description: GOOD_JD.repeat(3) }), NOW - 6 * DAY);
  const repost = atsJob(1, { sourceJobId: 'x', url: 'https://job-boards.greenhouse.io/acme1/jobs/77777', title: 'ML Engineer II', location: 'Remote', description: GOOD_JD.repeat(3) });
  assert.equal(s.lookup(repost).weakFirstSeen, NOW - 6 * DAY);
});

test('store: scan-history.tsv rows count as seen from day one (end of that day, never older)', () => {
  const tsv = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
    + 'https://job-boards.greenhouse.io/acme1/jobs/1001\t2026-10-01\tgh\tMachine Learning Engineer\tAcme 1\tadded\tNew York, NY\n';
  const s = new SeenStore({ history: historyRecords(tsv) });
  const look = s.lookup(atsJob(1));
  assert.ok(look.strongFirstSeen >= Date.parse('2026-10-01T23:59:00'));
  assert.equal(classifyFreshness(atsJob(1), look, NOW).status, STATUS.SEEN);
});

test('store: knownSourceIds returns recent LinkedIn ids (to skip paying for them)', () => {
  const s = new SeenStore({});
  s.upsert(li(), NOW - DAY);
  assert.deepEqual(s.knownSourceIds('apify-linkedin', { sinceMs: NOW - 7 * DAY }), ['4001']);
});
