// freshness.mjs — NEW / SEEN / POSSIBLE_REPOST / VERIFY / STALE.
//
// The rule: a job is NEW only with CREDIBLE evidence that
// the ORIGINAL posting is within the last 24 hours — an employer ATS publish
// time, or an employer day-only date that is today. An aggregator's displayed
// age, a missing date, or "first seen by job-radar today" is never enough on
// its own: those jobs are VERIFY. Anything the first-seen store has known for
// more than 24 hours is never fresh again, whatever a source now displays.
import { EVIDENCE, CREDIBLE_EVIDENCE } from './job.mjs';

export const DAY = 86_400_000;

export const STATUS = Object.freeze({
  NEW: 'NEW',
  SEEN: 'SEEN',
  POSSIBLE_REPOST: 'POSSIBLE_REPOST',
  VERIFY: 'VERIFY',
  STALE: 'STALE',
});

// FRESHNESS RULES:
//   exact employer timestamp      → accept only if ≤ 24 hours old
//   employer gives only a date    → accept only if it says TODAY
//   yesterday + no exact time     → exclude as unverifiable
//   LinkedIn/Indeed time never overrides the employer's date
// "Today" = the user's local calendar date, nothing else — a UTC-today
// fallback would admit a date that is already ~25h old on a US evening.
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The calendar day an employer date names: the day as written when we have it
// ("2026-10-11"); a bare UTC-midnight timestamp is the usual encoding of a
// date-only value, so it is read as that UTC date; anything else → local day.
export function employerCalendarDay(job) {
  if (job.postedDay) return job.postedDay;
  const d = new Date(job.postedAt);
  const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return utcMidnight ? d.toISOString().slice(0, 10) : localDay(job.postedAt);
}

function dayIsToday(job, now) {
  return employerCalendarDay(job) === localDay(now);
}

function fmtDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Is the credible posting time inside the window?
function credibleFresh(job, now, windowMs) {
  if (job.postedEvidence === EVIDENCE.DAY) return dayIsToday(job, now);
  const age = now - job.postedAt;
  return age >= -15 * 60_000 && age <= windowMs; // small clock-skew allowance
}

/**
 * @param {object} job       normalized job
 * @param {object} seen      SeenStore.lookup(job) result
 * @param {number} now
 * @returns {{status: string, fresh: boolean, freshSignal: 'credible'|'aggregator'|'none', originalAt: number|null, reason: string}}
 */
export function classifyFreshness(job, seen, now, windowMs = DAY) {
  const strongFirst = seen?.strongFirstSeen ?? null;
  const weakFirst = seen?.weakFirstSeen ?? null;
  const credible = CREDIBLE_EVIDENCE.has(job.postedEvidence) && Number.isFinite(job.postedAt);
  const listed = job.listedAt ?? (job.postedEvidence === EVIDENCE.AGGREGATOR ? job.postedAt : null);
  const listedFresh = Number.isFinite(listed) && now - listed <= windowMs;

  // Known to us for longer than the window: never fresh again.
  if (strongFirst != null && now - strongFirst > windowMs) {
    return {
      status: STATUS.SEEN, fresh: false, freshSignal: 'none', originalAt: strongFirst,
      reason: `first seen ${fmtDay(strongFirst)}${listedFresh ? '; source shows a refreshed time' : ''}`,
    };
  }
  const weakOld = weakFirst != null && now - weakFirst > windowMs;

  // The source itself says this listing is a repost (Indeed isRepost: true).
  if (job.sourceRepost) {
    return { status: STATUS.POSSIBLE_REPOST, fresh: false, freshSignal: 'none', originalAt: weakFirst ?? null,
      reason: 'the listing source marks it as a repost' };
  }

  if (credible) {
    if (!credibleFresh(job, now, windowMs)) {
      if (listedFresh) {
        return { status: STATUS.POSSIBLE_REPOST, fresh: false, freshSignal: 'none', originalAt: job.postedAt,
          reason: `employer first published ${fmtDay(job.postedAt)}; listing shows a fresh time` };
      }
      return { status: STATUS.STALE, fresh: false, freshSignal: 'none', originalAt: job.postedAt, reason: `posted ${fmtDay(job.postedAt)}` };
    }
    if (weakOld) {
      return { status: STATUS.POSSIBLE_REPOST, fresh: false, freshSignal: 'credible', originalAt: weakFirst,
        reason: `same company/title/location (or same text) first seen ${fmtDay(weakFirst)}` };
    }
    if (strongFirst != null) {
      return { status: STATUS.SEEN, fresh: true, freshSignal: 'credible', originalAt: Math.min(strongFirst, job.postedAt),
        reason: 'fresh, already shown in an earlier scan today' };
    }
    return { status: STATUS.NEW, fresh: true, freshSignal: 'credible', originalAt: job.postedAt,
      reason: job.postedEvidence === EVIDENCE.DAY ? 'employer date is today (day only)' : 'employer publish time within 24h' };
  }

  // No credible original date.
  if (Number.isFinite(listed) && !listedFresh) {
    return { status: STATUS.STALE, fresh: false, freshSignal: 'none', originalAt: listed, reason: `listed ${fmtDay(listed)}` };
  }
  if (weakOld) {
    return { status: STATUS.POSSIBLE_REPOST, fresh: false, freshSignal: 'none', originalAt: weakFirst,
      reason: `same company/title/location (or same text) first seen ${fmtDay(weakFirst)}` };
  }
  return {
    status: STATUS.VERIFY,
    fresh: false,
    freshSignal: listedFresh ? 'aggregator' : 'none',
    originalAt: null,
    reason: listedFresh ? 'listed within 24h; original employer date not established' : 'no posting date',
  };
}

// STRICT RULE (docs/GUARDRAILS.md): final results contain ONLY genuinely new
// jobs. SEEN, POSSIBLE_REPOST, STALE and VERIFY are always excluded.
export function freshnessAllowsFinal(f) {
  return f.status === STATUS.NEW;
}

// Worth checking at the employer? NEW jobs, plus aggregator listings ≤24h
// that employer verification might confirm. Never SEEN or POSSIBLE_REPOST.
export function freshnessAllowsCandidate(f) {
  if (f.status === STATUS.NEW) return true;
  return f.status === STATUS.VERIFY && f.freshSignal === 'aggregator';
}

/** @deprecated use freshnessAllowsFinal — kept so old callers fail closed. */
export const freshnessAllowsTop = freshnessAllowsFinal;

export function freshnessRank(f) {
  if (f.status === STATUS.NEW) return 0;
  if (f.status === STATUS.SEEN) return 1;
  return 2;
}
