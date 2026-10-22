// job.mjs — the one normalized job shape every discovery source produces.
//
// Sources differ wildly (ATS JSON, Apify datasets, pipeline lines); everything
// downstream — dedup, first-seen tracking, freshness, eligibility, scoring —
// only ever sees makeJob() output.
import { normalizeUrl, isAggregatorUrl } from '../vendor/url-key.mjs';

// How much a postedAt value can be trusted as the ORIGINAL posting time.
//   ats_first_published  employer ATS says when it was first published (Greenhouse first_published, Lever createdAt, Ashby publishedAt)
//   day_only             employer ATS gives only a calendar day (Workday "Posted Today")
//   aggregator_listed    LinkedIn/Indeed listing time — may be a refresh/repost, never proof on its own
//   none                 no date at all
export const EVIDENCE = Object.freeze({
  ATS: 'ats_first_published',
  DAY: 'day_only',
  AGGREGATOR: 'aggregator_listed',
  NONE: 'none',
});

export const CREDIBLE_EVIDENCE = new Set([EVIDENCE.ATS, EVIDENCE.DAY]);

export function cleanText(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// Lowercase alnum key; used for company/title/location identity.
export function normKey(v) {
  return cleanText(v).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const COMPANY_SUFFIX_RE = /\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|lp|llp|holdings|group|technologies|technology|labs)\b/g;
export function companyKey(name) {
  return normKey(name).replace(COMPANY_SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim()
    // "JPMorgan Chase & Co." → "jpmorgan chase and" after suffix removal: drop the
    // dangling connector (a mid-name "and", as in "Kirkland & Ellis", stays).
    .replace(/^(the )+/, '').replace(/( and)+$/, '').trim();
}

// Title identity: drop parenthetical noise and req-id tails, keep the words.
export function titleKey(title) {
  return normKey(String(title ?? '').replace(/\([^)]*\)/g, ' ').replace(/\b(req|job id|jr)\s*[#:]?\s*[a-z0-9-]*\d[a-z0-9-]*/gi, ' '));
}

const US_NOISE_RE = /\b(united states( of america)?|usa|us|u s|remote us|anywhere)\b/g;
export function locationKey(location) {
  return normKey(location).replace(US_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function canonicalUrl(url) {
  return normalizeUrl(String(url ?? ''));
}

export function isHttpsUrl(v) {
  try { return new URL(String(v)).protocol === 'https:'; } catch { return false; }
}

// Sources sometimes hand out http:// employer links (Indeed `jobUrl`). Upgrade
// to https so they can be used; anything unparseable becomes ''.
export function upgradeHttp(v) {
  const s = cleanText(v);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u.toString() : '';
  } catch { return ''; }
}

export function reqKey(v) {
  return cleanText(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const ATS_HOST_RE = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|workable\.com|bamboohr\.com|jobvite\.com|recruitee\.com|breezy\.hr|teamtailor\.com|successfactors\.com|oraclecloud\.com|eightfold\.ai|rippling\.com|gem\.com|dayforcehcm\.com|ultipro\.com|paylocity\.com|adp\.com)$/i;
export function isAtsUrl(url) {
  try { return ATS_HOST_RE.test(new URL(url).hostname); } catch { return false; }
}

// Job boards / aggregators: their pages are never "the employer's page".
// Includes the public boards the scan reads as discovery sources.
export const AGGREGATOR_HOST_RE = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|simplyhired\.com|monster\.com|dice\.com|careerbuilder\.com|talent\.com|jooble\.org|lensa\.com|remoteok\.com|remoteok\.io|remotive\.com|himalayas\.app|jobicy\.com|weworkremotely\.com|workingnomads\.com|nodesk\.co|jobspresso\.co|4dayweek\.io|builtin[a-z]*\.com|themuse\.com|ycombinator\.com|speedrun-talent-network\.com|agentic-engineering-jobs\.com|wellfound\.com|handshake\.com|joinhandshake\.com)$/i;

// An apply link we can hand the user as "the employer's page": https, not an
// aggregator (LinkedIn/Indeed/Glassdoor…). An ATS host or an employer domain both count.
export function isEmployerUrl(url) {
  if (!isHttpsUrl(url)) return false;
  if (isAggregatorUrl(url)) return false;
  return !AGGREGATOR_HOST_RE.test(new URL(url).hostname);
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} f
 * @returns {object} normalized job
 */
export function makeJob(f) {
  const url = cleanText(f.url);
  const employerUrl = f.employerUrl ? cleanText(f.employerUrl) : (isEmployerUrl(url) ? url : '');
  const postedAt = toMs(f.postedAt);
  let evidence = f.postedEvidence || (postedAt ? EVIDENCE.AGGREGATOR : EVIDENCE.NONE);
  if (!postedAt) evidence = EVIDENCE.NONE;
  return {
    source: f.source,
    sourceJobId: f.sourceJobId != null && f.sourceJobId !== '' ? String(f.sourceJobId) : '',
    requisitionId: f.requisitionId != null ? cleanText(f.requisitionId) : '',
    // A source's own "this is a repost" flag (Indeed isRepost). Only ever
    // pushes a job toward POSSIBLE_REPOST, never toward NEW.
    sourceRepost: f.sourceRepost === true,
    // Day-only employer dates keep the calendar day as written ("2026-10-11").
    postedDay: /^\d{4}-\d{2}-\d{2}$/.test(String(f.postedDay || '')) ? f.postedDay : '',
    url,
    employerUrl,
    company: cleanText(f.company),
    title: cleanText(f.title),
    location: cleanText(f.location),
    postedAt,
    postedEvidence: evidence,
    listedAt: toMs(f.listedAt) ?? (evidence === EVIDENCE.AGGREGATOR ? postedAt : null),
    description: f.description ? cleanText(f.description) : '',
    salary: f.salary || null,
    remote: Boolean(f.remote),
    // Set ONLY when the employer's own board/ATS returned this posting during
    // this scan (board listing, or a posting document that is open). Required
    // for final results (strict rule, 2026-10-11).
    liveVerified: f.liveVerified === true,
    liveVia: f.liveVia ? cleanText(f.liveVia) : '',
  };
}

// The one apply link a user may see: the verified employer/ATS posting URL.
// '' when there is none — such a job can never reach final results.
export function verifiedApplyUrl(job) {
  if (!job.liveVerified) return '';
  if (isEmployerUrl(job.employerUrl)) return job.employerUrl;
  return isEmployerUrl(job.url) ? job.url : '';
}

export function identityKeys(job) {
  const keys = [];
  if (job.sourceJobId) keys.push(`id:${job.source}:${job.sourceJobId}`);
  for (const u of [job.url, job.employerUrl]) {
    const k = canonicalUrl(u);
    if (k) keys.push(`url:${k}`);
  }
  // The employer's requisition number survives a re-release under a new
  // posting id (SmartRecruiters refNumber, Indeed refNum, Greenhouse req id).
  const rk = reqKey(job.requisitionId);
  const ck = companyKey(job.company);
  if (rk.length >= 3 && /\d/.test(rk) && ck) keys.push(`req:${ck}:${rk}`);
  return [...new Set(keys)];
}

// Same company + title + location: the weak identity a repost keeps when its
// id and URL change.
export function ctlKey(job) {
  const c = companyKey(job.company);
  const t = titleKey(job.title);
  if (!c || !t) return '';
  return `ctl:${c}|${t}|${locationKey(job.location)}`;
}
