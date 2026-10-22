// workday-verify.mjs — confirm a LinkedIn/Indeed-discovered job on the
// employer's own Workday site, using the public Workday tenant list that
// the rotation source caches (state/cache/ats-companies/workday.json,
// "tenant|instance|site" lines from the job-board-aggregator dataset).
//
// A job is confirmed ONLY if Workday itself shows ALL of:
//   1. live        the posting document is returned and canApply !== false
//   2. employer    Workday's hiringOrganization matches the company (or, with
//                  no hiringOrganization, the tenant IS the company's exact name)
//   3. same role   title match (≥0.8, same seniority/level tokens) or matching
//                  requisition id, compatible location, and no equally good
//                  alternative posting (ambiguity → reject)
//   4. date        jobPostingInfo.startDate (strict ISO) — the freshness gate
//                  then requires it to be today; postedOn must not contradict it
//   5. apply URL   Workday's own externalUrl, or the exact externalPath Workday
//                  returned on this tenant's host — never a URL we made up
// Anything unverifiable → null (the caller keeps the job out of the results).
import { companyKey, normKey, EVIDENCE } from './job.mjs';
import { employerMatches, levelSignature, compactCompany } from './match.mjs';
export { employerMatches, levelSignature };
import { titleSimilarity, workdayStartDay } from './ats.mjs';

const SLUG_RE = /^[A-Za-z0-9_-]+$/;
const JUNK_TENANT_RE = /^wd\d+$/i;          // same data-quality filter as scan-ats-full.mjs
const INTERNAL_SITE_RE = /internal/i;       // internal-only boards are not public apply pages

const compact = compactCompany;

export function acronym(company) {
  const words = companyKey(company).split(' ').filter(Boolean);
  return words.length >= 2 ? words.map((w) => w[0]).join('') : '';
}

/**
 * @param {string[]} lines  "tenant|instance|site"
 * @param {Array<{tenant, instance, site, company}>} [tracked]  tracked Workday boards (company known)
 */
export function buildWorkdayIndex(lines, tracked = []) {
  const byTenant = new Map();
  for (const raw of lines || []) {
    const [tenant, instance, site] = String(raw).split('|');
    if (![tenant, instance, site].every((p) => p && SLUG_RE.test(p))) continue;
    if (JUNK_TENANT_RE.test(tenant) || INTERNAL_SITE_RE.test(site)) continue;
    const t = tenant.toLowerCase();
    if (!byTenant.has(t)) byTenant.set(t, []);
    byTenant.get(t).push({ tenant, instance, site });
  }
  const trackedByCompany = new Map();
  for (const b of tracked) trackedByCompany.set(compact(b.company), { tenant: b.tenant, instance: b.instance, site: b.site });
  return { byTenant, trackedByCompany };
}

/**
 * Candidate boards for a company, strongest evidence first:
 *   tracked  your portals.yml lists this company on this Workday board
 *   exact    tenant == company name (letters/digits only)
 *   prefix   tenant starts with the company name, or vice versa (≥5 chars)
 *   acronym  tenant == initials of a ≥2-word name ("Booz Allen Hamilton" → bah)
 * prefix/acronym boards are accepted ONLY if Workday's hiringOrganization
 * then names the same employer (enforced in verifyViaWorkday).
 */
export function workdayCandidates(company, index, { max = 3 } = {}) {
  const c = compact(company);
  if (!c || c.length < 3) return [];
  const out = [];
  const push = (b, via) => { if (b && !out.some((x) => x.tenant === b.tenant && x.site === b.site)) out.push({ ...b, via }); };
  push(index.trackedByCompany.get(c), 'tracked');
  for (const b of (index.byTenant.get(c) || []).slice(0, 2)) push(b, 'exact');
  if (c.length >= 5) {
    for (const [t, boards] of index.byTenant) {
      if (t === c || t.length < 5) continue;
      if (t.startsWith(c) || c.startsWith(t)) for (const b of boards.slice(0, 1)) push(b, 'prefix');
      if (out.length >= max + 2) break;
    }
  }
  const ac = acronym(company);
  if (ac.length >= 3) for (const b of (index.byTenant.get(ac) || []).slice(0, 1)) push(b, 'acronym');
  return out.slice(0, max);
}

const reqKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cityTokens(loc) {
  return new Set(normKey(loc).split(' ').filter((w) => w.length > 2 && !['remote', 'hybrid', 'united', 'states', 'usa'].includes(w)));
}
function locationScore(a, b) {
  if (!a || !b) return 0;                              // unknown on one side: neutral
  if (/remote|anywhere/i.test(a) && /remote|anywhere/i.test(b)) return 0.15;
  const A = cityTokens(a); const B = cityTokens(b);
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  if (shared) return 0.15;
  if (/remote|anywhere/i.test(a) || /remote|anywhere/i.test(b)) return 0;
  return -1;                                           // clearly different places
}

/**
 * Score one Workday list posting against the discovered job.
 * Returns null when it cannot be the same role.
 */
export function scorePosting(job, p) {
  const sim = titleSimilarity(job.title, p.title);
  const sameLevel = levelSignature(job.title) === levelSignature(p.title);
  const rq = reqKey(job.requisitionId);
  const reqMatch = rq.length >= 3 && (p.bulletFields || []).some((f) => reqKey(f) === rq);
  const loc = locationScore(job.location, p.locationsText);
  if (loc < 0) return null;
  if (reqMatch && sim >= 0.5) return { score: 2 + sim + loc, sim, reqMatch, sameLevel };
  if (sim >= 0.8 && sameLevel) return { score: sim + loc, sim, reqMatch: false, sameLevel };
  return null;
}

// Pick the one posting that matches — or nobody, if two are equally plausible.
export function pickUnique(job, postings, { margin = 0.1 } = {}) {
  const scored = postings.map((p) => ({ p, m: scorePosting(job, p) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score);
  if (!scored.length) return { pick: null, reason: 'no matching title on the employer Workday board' };
  if (scored.length > 1 && !scored[0].m.reqMatch && scored[0].m.score - scored[1].m.score < margin) {
    return { pick: null, reason: `ambiguous: ${scored.length} similar postings on the employer Workday board` };
  }
  return { pick: scored[0], reason: null };
}

function hostOf(b) { return `${b.tenant}.${b.instance}.myworkdayjobs.com`; }

/**
 * @returns {Promise<{facts: object|null, reason: string}>}
 *   facts: { employerUrl, postedAt, postedDay, evidence, live, closed, requisitionId, description, via }
 */
export async function verifyViaWorkday(job, { fetchJson, index }) {
  if (!index) return { facts: null, reason: 'no Workday tenant list' };
  const boards = workdayCandidates(job.company, index);
  if (!boards.length) return { facts: null, reason: 'employer not found in the Workday tenant list' };
  let lastReason = 'no match';
  for (const b of boards) {
    const host = hostOf(b);
    const cxs = `https://${host}/wday/cxs/${b.tenant}/${b.site}`;
    const list = await fetchJson(`${cxs}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: String(job.title).slice(0, 100) }),
    });
    const postings = Array.isArray(list?.jobPostings) ? list.jobPostings.filter((p) => p?.title && typeof p.externalPath === 'string' && p.externalPath.startsWith('/job/')) : [];
    if (!postings.length) { lastReason = `no postings returned by ${b.tenant}`; continue; }
    const { pick, reason } = pickUnique(job, postings);
    if (!pick) { lastReason = reason; continue; }

    // The posting document, at the exact path Workday returned.
    const detail = await fetchJson(`${cxs}${pick.p.externalPath}`);
    const info = detail?.jobPostingInfo;
    if (!info) { lastReason = 'posting document unavailable'; continue; }

    // 2. employer
    const org = detail?.hiringOrganization?.name || '';
    const employerOk = org ? employerMatches(job.company, org)
      : (b.via === 'tracked' || b.via === 'exact'); // no org name: only an exact/tracked tenant counts
    if (!employerOk) { lastReason = org ? `employer mismatch (Workday says "${org}")` : 'employer not confirmable'; continue; }

    // 3. the detail must describe the same role as the list entry
    if (titleSimilarity(pick.p.title, info.title || pick.p.title) < 0.8) { lastReason = 'posting document title differs'; continue; }

    // 5. official apply URL: Workday's externalUrl on this tenant's host, else the exact path it returned.
    let applyUrl = '';
    try {
      const u = info.externalUrl ? new URL(info.externalUrl) : null;
      if (u && u.protocol === 'https:' && u.hostname === host) applyUrl = u.toString();
    } catch { /* ignore */ }
    if (!applyUrl) applyUrl = `https://${host}/${b.site}${pick.p.externalPath}`;

    // 4. date: strict ISO startDate; a postedOn label that contradicts "today" voids it.
    const day = workdayStartDay(info.startDate);
    const label = String(info.postedOn || pick.p.postedOn || '');
    const contradicts = day && label && !/posted today/i.test(label);
    const closed = info.canApply === false;
    const datedOk = day && !contradicts;
    return {
      facts: {
        employerUrl: applyUrl,
        postedAt: datedOk ? Date.parse(`${day}T00:00:00Z`) : null,
        postedDay: datedOk ? day : '',
        evidence: datedOk ? EVIDENCE.DAY : EVIDENCE.NONE,
        live: !closed,
        closed,
        requisitionId: info.jobReqId || '',
        description: String(info.jobDescription || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        title: info.title || pick.p.title,
        via: `workday ${b.tenant}/${b.site} (${b.via}${pick.m.reqMatch ? ', req match' : ''})`,
      },
      reason: datedOk ? 'ok' : (contradicts ? `postedOn "${label}" contradicts startDate` : 'no usable startDate'),
    };
  }
  return { facts: null, reason: lastReason };
}
