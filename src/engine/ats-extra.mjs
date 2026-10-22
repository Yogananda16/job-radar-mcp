// ats-extra.mjs — read ONE posting on Oracle Recruiting Cloud or iCIMS, the
// systems many large / Connecticut employers use (JPMC, Uber, …).
//
//   Oracle  public CandidateExperience REST API (same API providers/oraclecloud.mjs
//           uses): recruitingCEJobRequisitionDetails ById → ExternalPostedStartDate,
//           an exact timestamp with offset. A requisition that is no longer posted
//           returns no item (verified on JPMC 2026-10-12) → null.
//   iCIMS   the posting page's schema.org JobPosting JSON-LD (same source
//           providers/icims.mjs enrichDate reads): datePosted, validThrough,
//           hiringOrganization. No JobPosting → null.
// Every value comes from the employer's own system; nothing is inferred.
import { resolveSite } from '../vendor/providers/oraclecloud.mjs';
import { EVIDENCE } from './job.mjs';

const strip = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// An ISO timestamp with an explicit time AND offset/Z is exact; a bare date is
// day-only; anything else is unusable.
export function classifyIsoDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? { postedAt: t, evidence: EVIDENCE.ATS, postedDay: '' } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { postedAt: Date.parse(`${s}T00:00:00Z`), evidence: EVIDENCE.DAY, postedDay: s };
  }
  return null;
}

// ── Oracle ───────────────────────────────────────────────────────────

export function parseOracleJobUrl(url) {
  const site = resolveSite({ careers_url: String(url || '') });
  const m = String(url || '').match(/\/job\/(\d+)(?:[/?#]|$)/);
  return site && m ? { ...site, id: m[1] } : null;
}

export function oracleJobUrl(site, id) {
  return `https://${site.host}/hcmUI/CandidateExperience/${site.lang || 'en'}/sites/${site.siteNumber}/job/${id}`;
}

export function oracleDetailApi(site, id) {
  return `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
    + `?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${site.siteNumber}`;
}

export async function fetchOraclePosting(url, fetchJson, now = Date.now()) {
  const p = parseOracleJobUrl(url);
  if (!p) return null;
  const item = (await fetchJson(oracleDetailApi(p, p.id)))?.items?.[0];
  if (!item || String(item.Id) !== p.id) return null; // not posted (closed/removed) or wrong site
  const ended = Date.parse(item.ExternalPostedEndDate || '');
  const closed = Number.isFinite(ended) && ended < now;
  const date = classifyIsoDate(item.ExternalPostedStartDate);
  return {
    postedAt: date?.postedAt ?? null,
    postedDay: date?.postedDay || '',
    evidence: date?.evidence || EVIDENCE.NONE,
    description: strip([item.ExternalDescriptionStr, item.ExternalResponsibilitiesStr, item.ExternalQualificationsStr].filter(Boolean).join('\n')),
    requisitionId: item.RequisitionNumber || String(item.Id), // Oracle's public job number is the req number (e.g. JPMC 210794583)
    title: item.Title || '',
    location: [item.PrimaryLocation, ...(item.secondaryLocations || []).map((l) => l?.Name)].filter(Boolean).join(' · '),
    employerUrl: oracleJobUrl(p, p.id),
    live: !closed,
    closed,
  };
}

// ── iCIMS ────────────────────────────────────────────────────────────

const ICIMS_HOST_RE = /^[a-z0-9-]+\.icims\.com$/i;

export function parseIcimsJobUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'https:' || !ICIMS_HOST_RE.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/jobs\/(\d+)(?:\/|$)/);
  return m ? { origin: `https://${u.hostname.toLowerCase()}`, id: m[1] } : null;
}

export function jsonLdNodes(html) {
  const nodes = [];
  for (const [, raw] of String(html || '').matchAll(/<script\b[^>]*(?<![\w-])type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (Array.isArray(data)) nodes.push(...data);
    else if (Array.isArray(data?.['@graph'])) nodes.push(...data['@graph']);
    else nodes.push(data);
  }
  return nodes.filter((n) => n && typeof n === 'object');
}

const isJobPosting = (n) => n['@type'] === 'JobPosting' || (Array.isArray(n['@type']) && n['@type'].includes('JobPosting'));

export async function fetchIcimsPosting(url, fetchText, now = Date.now()) {
  const p = parseIcimsJobUrl(url);
  if (!p || typeof fetchText !== 'function') return null;
  const canonical = `${p.origin}/jobs/${p.id}/job`;
  const html = await fetchText(`${canonical}?in_iframe=1`);
  const jp = jsonLdNodes(html).find(isJobPosting);
  if (!jp) return null; // no structured posting → not verifiable
  const until = Date.parse(jp.validThrough || '');
  const closed = Number.isFinite(until) && until < now;
  const date = classifyIsoDate(jp.datePosted);
  const org = jp.hiringOrganization && typeof jp.hiringOrganization === 'object' ? jp.hiringOrganization.name : jp.hiringOrganization;
  return {
    postedAt: date?.postedAt ?? null,
    postedDay: date?.postedDay || '',
    evidence: date?.evidence || EVIDENCE.NONE,
    description: strip(jp.description),
    requisitionId: jp.identifier?.value != null ? String(jp.identifier.value) : '',
    title: String(jp.title || ''),
    org: typeof org === 'string' ? org.trim() : '',
    employerUrl: canonical,
    live: !closed,
    closed,
  };
}
