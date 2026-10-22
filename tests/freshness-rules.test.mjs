// The four freshness rules (docs/GUARDRAILS.md), pinned down:
//   1. exact employer timestamp      → accept only if ≤ 24 hours old
//   2. employer gives only a date    → accept only if it says today
//   3. yesterday + no exact time     → exclude as unverifiable
//   4. LinkedIn/Indeed time never overrides employer freshness
// Dates are built with the same local-day helper the code uses, so these
// hold in any machine timezone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness, finalGateReasonFor, STATUS, localDay, employerCalendarDay } from './_freshness-shim.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';
import { applyEmployerFacts } from '../src/engine/run.mjs';
import { NOW, HOUR, DAY, atsJob } from './helpers.mjs';

const none = { strongFirstSeen: null, weakFirstSeen: null };
const status = (job, now = NOW) => classifyFreshness(job, none, now).status;
const dayOnly = (day, patch = {}) => atsJob(1, { postedEvidence: EVIDENCE.DAY, postedDay: day, postedAt: Date.parse(`${day}T00:00:00Z`), ...patch });

// ── 1. Exact timestamp ≤ 24h ─────────────────────────────────────────

test('1: exact employer timestamp 23h59m old → NEW; 24h01m old → excluded', () => {
  assert.equal(status(atsJob(1, { postedAt: NOW - (24 * HOUR - 60_000) })), STATUS.NEW);
  assert.equal(status(atsJob(1, { postedAt: NOW - (24 * HOUR + 60_000) })), STATUS.STALE);
  assert.equal(finalGateReasonFor(atsJob(1, { postedAt: NOW - 25 * HOUR })), 'older than 24h');
});

// ── 2. Date only → must be today ─────────────────────────────────────

test('2: date-only employer date equal to today → NEW', () => {
  assert.equal(status(dayOnly(localDay(NOW))), STATUS.NEW);
});

test('2: "today" means the local calendar date — late evening, a date already "today" in UTC but tomorrow locally is not accepted', () => {
  const lateEvening = new Date(NOW); lateEvening.setHours(23, 30, 0, 0);
  const now = lateEvening.getTime();
  assert.equal(status(dayOnly(localDay(now)), now), STATUS.NEW);
  const utcDay = new Date(now).toISOString().slice(0, 10);
  if (utcDay !== localDay(now)) assert.equal(status(dayOnly(utcDay), now), STATUS.STALE);
});

test('2: a bare UTC-midnight timestamp is read as that date (date-only encoding)', () => {
  const d = localDay(NOW);
  assert.equal(employerCalendarDay({ postedAt: Date.parse(`${d}T00:00:00Z`) }), d);
});

// ── 3. Yesterday without a time → excluded ───────────────────────────

test('3: yesterday as a date-only value → excluded (never NEW), even right after midnight', () => {
  const yesterday = localDay(NOW - DAY);
  assert.notEqual(status(dayOnly(yesterday)), STATUS.NEW);
  const justAfterMidnight = new Date(NOW); justAfterMidnight.setHours(0, 5, 0, 0);
  assert.notEqual(status(dayOnly(localDay(justAfterMidnight.getTime() - DAY)), justAfterMidnight.getTime()), STATUS.NEW,
    'only ~5 minutes into today, but the date says yesterday → still excluded');
});

test('3: Workday "Posted Yesterday" label voids a startDate (see workday tests) — and no date → never NEW', () => {
  assert.equal(status(atsJob(1, { postedAt: null })), STATUS.VERIFY);
  assert.notEqual(finalGateReasonFor(atsJob(1, { postedAt: null })), null);
});

// ── 4. LinkedIn/Indeed never override the employer ───────────────────

const li = (patch = {}) => makeJob({
  source: 'apify-linkedin', sourceJobId: 'l1', url: 'https://www.linkedin.com/jobs/view/1', company: 'Acme 1',
  title: 'Machine Learning Engineer', location: 'New York, NY', postedAt: NOW - 10 * 60_000, postedEvidence: EVIDENCE.AGGREGATOR, ...patch,
});

test('4: LinkedIn "10 minutes ago" alone → not NEW', () => {
  assert.equal(status(li()), STATUS.VERIFY);
});

test('4: LinkedIn "10 minutes ago" + employer date yesterday → excluded (possible repost)', () => {
  const j = li();
  applyEmployerFacts(j, { evidence: EVIDENCE.DAY, postedAt: Date.parse(`${localDay(NOW - DAY)}T00:00:00Z`), postedDay: localDay(NOW - DAY), live: true, employerUrl: 'https://job-boards.greenhouse.io/acme1/jobs/1' });
  assert.equal(status(j), STATUS.POSSIBLE_REPOST);
});

test('4: LinkedIn "10 minutes ago" + employer timestamp 30h old → excluded (possible repost)', () => {
  const j = li();
  applyEmployerFacts(j, { evidence: EVIDENCE.ATS, postedAt: NOW - 30 * HOUR, live: true, employerUrl: 'https://job-boards.greenhouse.io/acme1/jobs/1' });
  assert.equal(status(j), STATUS.POSSIBLE_REPOST);
});

test('4: an aggregator time can never be promoted to an employer date', () => {
  const j = li();
  applyEmployerFacts(j, { evidence: EVIDENCE.AGGREGATOR, postedAt: NOW - HOUR, live: true, employerUrl: 'https://job-boards.greenhouse.io/acme1/jobs/1' });
  assert.equal(j.postedEvidence, EVIDENCE.AGGREGATOR);
  assert.equal(status(j), STATUS.VERIFY);
});
