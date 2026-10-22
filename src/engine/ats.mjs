// ats.mjs — employer-ATS lookups: exact first-publish times and employer
// verification for aggregator (LinkedIn/Indeed) jobs. Greenhouse, Lever and
// Ashby public APIs only; every request goes through the caller's bounded
// fetchJson (8s cap, abortable), so nothing here can outlive the scan.
import { EVIDENCE, companyKey, normKey, isEmployerUrl } from './job.mjs';
import { employerMatches, levelSignature } from './match.mjs';
import { parseOracleJobUrl, parseIcimsJobUrl, fetchOraclePosting, fetchIcimsPosting } from './ats-extra.mjs';

const htmlToText = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function parseAtsUrl(url) {
  let m;
  const u = String(url || '');
  if ((m = u.match(/^https:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9._-]+)\/jobs\/(\d+)/))) return { ats: 'greenhouse', slug: m[1], id: m[2] };
  if ((m = u.match(/^https:\/\/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9._-]+)\/([0-9a-f-]{36})/i))) return { ats: 'lever', slug: m[1], id: m[2] };
  if ((m = u.match(/^https:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9._%-]+)\/([0-9a-f-]{36})/i))) return { ats: 'ashby', slug: decodeURIComponent(m[1]), id: m[2] };
  return null;
}

export function boardFromCareersUrl(url) {
  let m;
  const u = String(url || '');
  if ((m = u.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9._-]+)/))) return { ats: 'greenhouse', slug: m[1] };
  if ((m = u.match(/lever\.co\/([A-Za-z0-9._-]+)/))) return { ats: 'lever', slug: m[1] };
  if ((m = u.match(/ashbyhq\.com\/([A-Za-z0-9._%-]+)/))) return { ats: 'ashby', slug: decodeURIComponent(m[1]) };
  return null;
}

// ── Workday ──────────────────────────────────────────────────────────
// Public posting → its CXS detail document (same derivation as
// providers/workday.mjs: cxsBase + externalPath). Not every tenant serves it
// (some answer 4xx/422); any failure → null → the job stays VERIFY.
const WD_JOBS_RE = /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)(\/job\/[^?#]+)/;
const WD_SITE_RE = /^https:\/\/([\w-]+)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([\w-]+)\/([^/?#]+)(\/job\/[^?#]+)/;

export function parseWorkdayUrl(url) {
  const u = String(url || '');
  let m;
  if ((m = u.match(WD_JOBS_RE)) && m[3] !== 'wday') {
    return { ats: 'workday', cxsUrl: `https://${m[1]}.${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}${m[4].replace(/\/+$/, '')}` };
  }
  if ((m = u.match(WD_SITE_RE))) {
    return { ats: 'workday', cxsUrl: `https://${m[1]}.myworkdaysite.com/wday/cxs/${m[2]}/${m[3]}${m[4].replace(/\/+$/, '')}` };
  }
  return null;
}

// jobPostingInfo.startDate is a calendar date ("2026-10-11"; 11/11 documents
// measured upstream had no time). Only a strict ISO date (or date-time with an
// explicit offset) is accepted; anything else → no date.
export function workdayStartDay(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  }
  return null;
}

async function fetchWorkdayPosting(url, fetchJson) {
  const p = parseWorkdayUrl(url);
  if (!p) return null;
  const detail = await fetchJson(p.cxsUrl);
  const info = detail?.jobPostingInfo;
  if (!info || typeof info !== 'object') return null; // endpoint not available for this tenant
  let day = info.canApply === false ? null : workdayStartDay(info.startDate);
  // A postedOn label that contradicts a "today" startDate voids the date.
  if (day && info.postedOn && !/posted today/i.test(String(info.postedOn))) day = null;
  // Apply URL: Workday's own externalUrl, only if it is on the same Workday host
  // as the link we verified; otherwise that verified link itself.
  let employerUrl = url;
  try {
    const u = info.externalUrl ? new URL(info.externalUrl) : null;
    if (u && u.protocol === 'https:' && u.hostname === new URL(url).hostname) employerUrl = u.toString();
  } catch { /* keep url */ }
  return {
    postedAt: day ? Date.parse(`${day}T00:00:00Z`) : null,
    postedDay: day || '',
    evidence: day ? EVIDENCE.DAY : EVIDENCE.NONE, // day only: NEW requires the day to be today
    description: htmlToText(info.jobDescription),
    requisitionId: info.jobReqId || '',
    title: info.title || '',
    org: detail?.hiringOrganization?.name || '',
    employerUrl,
    live: info.canApply !== false, // the employer says it is open
    closed: info.canApply === false,
  };
}

// ── SmartRecruiters ──────────────────────────────────────────────────
// Public posting jobs.smartrecruiters.com/{slug}/{id}-{title} → the public
// Posting API (same host and path providers/smartrecruiters.mjs uses).
// releasedDate is exact. A re-release gets a NEW posting id but keeps
// refNumber, so refNumber feeds the first-seen store's requisition key.
const SR_RE = /^https:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9._-]+)\/(\d{6,})/;

export function parseSmartRecruitersUrl(url) {
  const m = String(url || '').match(SR_RE);
  return m ? { ats: 'smartrecruiters', slug: m[1], id: m[2], apiUrl: `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}` } : null;
}

function srText(d) {
  const sections = d?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  return htmlToText(Object.values(sections).map((s) => s?.text || '').join(' '));
}

async function fetchSmartRecruitersPosting(url, fetchJson) {
  const p = parseSmartRecruitersUrl(url);
  if (!p) return null;
  const d = await fetchJson(p.apiUrl);
  if (!d || typeof d !== 'object' || (!d.id && !d.name)) return null; // endpoint not available
  const released = d.active === false ? NaN : Date.parse(d.releasedDate || '');
  const exact = typeof d.releasedDate === 'string' && /T\d{2}:\d{2}/.test(d.releasedDate) && Number.isFinite(released);
  return {
    postedAt: exact ? released : null,
    evidence: exact ? EVIDENCE.ATS : EVIDENCE.NONE,
    description: srText(d),
    requisitionId: d.refNumber || '',
    title: d.name || '',
    employerUrl: url,
    live: d.active !== false,
    closed: d.active === false,
  };
}

// Any posting URL on an ATS we can read directly.
export function employerAtsKind(url) {
  return parseAtsUrl(url)?.ats || parseWorkdayUrl(url)?.ats || parseSmartRecruitersUrl(url)?.ats
    || (parseOracleJobUrl(url) ? 'oracle' : null) || (parseIcimsJobUrl(url) ? 'icims' : null) || null;
}

// One posting → { postedAt, evidence, description, employerUrl, requisitionId?, postedDay? } from its own ATS.
// fetchText is needed only for iCIMS (HTML posting page); without it iCIMS returns null.
export async function fetchAtsPosting(url, fetchJson, fetchText = null) {
  if (parseWorkdayUrl(url)) return fetchWorkdayPosting(url, fetchJson);
  if (parseOracleJobUrl(url)) return fetchOraclePosting(url, fetchJson);
  if (parseIcimsJobUrl(url)) return fetchIcimsPosting(url, fetchText);
  if (parseSmartRecruitersUrl(url)) return fetchSmartRecruitersPosting(url, fetchJson);
  const p = parseAtsUrl(url);
  if (!p) return null;
  if (p.ats === 'greenhouse') {
    const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${p.slug}/jobs/${p.id}`);
    if (!j) return null;
    const t = Date.parse(j.first_published || '');
    return { postedAt: Number.isFinite(t) ? t : null, evidence: Number.isFinite(t) ? EVIDENCE.ATS : EVIDENCE.NONE, description: htmlToText(j.content), employerUrl: j.absolute_url || url, live: true };
  }
  if (p.ats === 'lever') {
    const j = await fetchJson(`https://api.lever.co/v0/postings/${p.slug}/${p.id}`);
    if (!j) return null;
    const t = typeof j.createdAt === 'number' ? j.createdAt : null;
    return { postedAt: t, evidence: t ? EVIDENCE.ATS : EVIDENCE.NONE, description: htmlToText(j.descriptionPlain || j.description), employerUrl: j.hostedUrl || url, live: true };
  }
  const board = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(p.slug)}`);
  const job = board?.jobs?.find((x) => x.id === p.id);
  if (!job) return null;
  const t = Date.parse(job.publishedAt || '');
  return { postedAt: Number.isFinite(t) ? t : null, evidence: Number.isFinite(t) ? EVIDENCE.ATS : EVIDENCE.NONE, description: htmlToText(job.descriptionPlain || job.descriptionHtml), employerUrl: job.jobUrl || url, live: true };
}

// Board listing for one ATS slug, normalized. Cached by the caller-provided Map.
export async function fetchBoard(ats, slug, fetchJson, cache) {
  const key = `${ats}:${slug}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (ats === 'greenhouse') {
      const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      return (j?.jobs || []).map((x) => ({ title: x.title, url: x.absolute_url, location: x.location?.name || '', postedAt: Date.parse(x.first_published || '') || null }));
    }
    if (ats === 'lever') {
      const j = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      return (Array.isArray(j) ? j : []).map((x) => ({ title: x.text, url: x.hostedUrl, location: x.categories?.location || '', postedAt: typeof x.createdAt === 'number' ? x.createdAt : null, description: htmlToText(x.descriptionPlain) }));
    }
    const j = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
    return (j?.jobs || []).map((x) => ({ title: x.title, url: x.jobUrl, location: x.location || '', postedAt: Date.parse(x.publishedAt || '') || null, description: htmlToText(x.descriptionPlain) }));
  })().catch(() => []);
  cache.set(key, p);
  return p;
}

function tokens(s) {
  return new Set(normKey(s).split(' ').filter((w) => w.length > 1 && !['and', 'the', 'of', 'for', 'remote', 'hybrid'].includes(w)));
}
export function titleSimilarity(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
function locationCompatible(a, b) {
  if (!a || !b) return true;
  if (/remote/i.test(a) || /remote/i.test(b)) return true;
  const A = tokens(a); const B = tokens(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}

export function slugCandidates(company) {
  const k = companyKey(company);
  if (!k) return [];
  return [...new Set([k.replace(/ /g, ''), k.replace(/ /g, '-')])].slice(0, 2);
}

/**
 * Try to find an aggregator job at the employer's own ATS.
 * @returns {Promise<{employerUrl, postedAt, evidence, description, via}|null>}
 */
export async function verifyAtEmployer(job, { fetchJson, fetchText = null, boardCache, trackedBoards = new Map() }) {
  // 1. The listing already links to the employer.
  if (job.employerUrl && isEmployerUrl(job.employerUrl)) {
    const kind = employerAtsKind(job.employerUrl);
    const direct = kind ? await fetchAtsPosting(job.employerUrl, fetchJson, fetchText).catch(() => null) : null;
    // The posting must be the same role (guards against a recycled link) and,
    // where the ATS names the employer, the same employer.
    const sameRole = direct && (!direct.title || (titleSimilarity(job.title, direct.title) >= 0.5
      && (kind !== 'workday' || levelSignature(job.title) === levelSignature(direct.title))));
    const sameEmployer = direct && (!direct.org || employerMatches(job.company, direct.org));
    if (sameRole && sameEmployer) {
      return { ...direct, via: `apply link → ${kind}` };
    }
    return { employerUrl: job.employerUrl, postedAt: null, evidence: EVIDENCE.NONE, description: '', live: false, via: 'apply link (employer site, no API: not verifiable)' };
  }
  // 2. Look the company up on Greenhouse / Lever / Ashby.
  const boards = [];
  const tracked = trackedBoards.get(companyKey(job.company));
  if (tracked) boards.push(tracked);
  for (const slug of slugCandidates(job.company)) for (const ats of ['greenhouse', 'lever', 'ashby']) boards.push({ ats, slug });
  const seen = new Set();
  for (const b of boards) {
    const k = `${b.ats}:${b.slug}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const list = await fetchBoard(b.ats, b.slug, fetchJson, boardCache);
    let best = null;
    for (const p of list) {
      const s = titleSimilarity(job.title, p.title);
      if (s >= 0.75 && locationCompatible(job.location, p.location) && (!best || s > best.s)) best = { s, p };
    }
    if (best) {
      const { p } = best;
      return { employerUrl: p.url, postedAt: p.postedAt || null, evidence: p.postedAt ? EVIDENCE.ATS : EVIDENCE.NONE, description: p.description || "", live: true, via: `${b.ats} board "${b.slug}"` };
    }
  }
  return null;
}
