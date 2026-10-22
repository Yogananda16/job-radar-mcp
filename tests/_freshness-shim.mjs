// Small test shim: freshness exports plus a one-call "would the final gate
// show this job?" helper for a freshly classified job.
import { classifyFreshness, STATUS, localDay, employerCalendarDay } from '../src/engine/freshness.mjs';
import { finalGateReason } from '../src/engine/run.mjs';

export { classifyFreshness, STATUS, localDay, employerCalendarDay };

export function finalGateReasonFor(job, now = Date.parse('2026-10-11T15:00:00Z')) {
  const fresh = classifyFreshness(job, { strongFirstSeen: null, weakFirstSeen: null }, now);
  return finalGateReason({ job, fresh, elig: { eligibility: 'OK' } });
}
