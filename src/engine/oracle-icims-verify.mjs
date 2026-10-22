// oracle-icims-verify.mjs — find a LinkedIn/Indeed/board-discovered job on the
// employer's own Oracle Recruiting Cloud or iCIMS site, by company + title.
//
// Which site belongs to the company (never guessed by name alone for Oracle):
//   Oracle  only sites tied to the company in config — discovery.companyBoards
//           or a tracked portals.yml entry. Oracle has no public tenant list.
//   iCIMS   the public iCIMS tenant list scan-ats-full.mjs uses, EXACT tenant
//           name only; the posting's own hiringOrganization must then name the
//           same employer (configured/tracked sites skip that check).
// Matching reuses the Workday rules (pickUnique): title ≥0.8 with identical
// seniority words, or a matching requisition id; compatible location; two
// equally good postings = ambiguous = no match. Then the posting itself is read
// (ats-extra.mjs) for date / open status / apply URL. Anything short of that →
// null, and the strict gate keeps the job out.
import { resolveSite } from '../vendor/providers/oraclecloud.mjs';
import { parseIcimsSearchPage } from '../vendor/providers/icims.mjs';
import { icimsHostCandidates } from '../vendor/ats-datasets.mjs';
import { fetchOraclePosting, fetchIcimsPosting, oracleJobUrl } from './ats-extra.mjs';
import { pickUnique } from './workday-verify.mjs';
import { employerMatches, compactCompany } from './match.mjs';
import { titleSimilarity } from './ats.mjs';

// ── Oracle ───────────────────────────────────────────────────────────

/** Oracle sites tied to this company in config (companyBoards / tracked). */
export function oracleSitesFor(company, { companyBoards = {}, trackedCompanies = [] } = {}) {
  const sites = [];
  const add = (url, via) => {
    const s = resolveSite({ careers_url: url });
    if (s && !sites.some((x) => x.host === s.host && x.siteNumber === s.siteNumber)) sites.push({ ...s, via });
  };
  for (const [name, entries] of Object.entries(companyBoards || {})) {
    if (!employerMatches(company, name) && compactCompany(company) !== compactCompany(name)) continue;
    for (const e of entries || []) add(e?.careers_url || e?.api, 'configured');
  }
  for (const e of trackedCompanies || []) {
    if (e?.enabled === false || !e?.careers_url) continue;
    if (employerMatches(company, e.name) || compactCompany(company) === compactCompany(e.name)) add(e.careers_url, 'tracked');
  }
  return sites;
}

export function oracleSearchApi(site, keyword, limit = 25) {
  const kw = encodeURIComponent(String(keyword).replace(/[,;"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100));
  return `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true&expand=${encodeURIComponent('requisitionList.secondaryLocations')}`
    + `&finder=findReqs;siteNumber=${site.siteNumber},keyword=${kw},limit=${limit},sortBy=POSTING_DATES_DESC`;
}

export async function verifyViaOracle(job, { fetchJson, companyBoards, trackedCompanies, now = Date.now() }) {
  const sites = oracleSitesFor(job.company, { companyBoards, trackedCompanies });
  if (!sites.length) return { facts: null, reason: 'no Oracle site configured for this employer' };
  let reason = 'no match';
  for (const site of sites) {
    const list = (await fetchJson(oracleSearchApi(site, job.title)))?.items?.[0]?.requisitionList;
    const postings = (Array.isArray(list) ? list : []).filter((r) => r?.Id && r?.Title).map((r) => ({
      title: r.Title,
      locationsText: [r.PrimaryLocation, ...(r.secondaryLocations || []).map((l) => l?.Name)].filter(Boolean).join(' · '),
      externalPath: String(r.Id),
      bulletFields: [String(r.Id)],
    }));
    if (!postings.length) { reason = `no postings returned by ${site.host}`; continue; }
    const { pick, reason: why } = pickUnique(job, postings);
    if (!pick) { reason = why; continue; }
    const posting = await fetchOraclePosting(oracleJobUrl(site, pick.p.externalPath), fetchJson, now);
    if (!posting) { reason = 'posting not available on Oracle'; continue; }
    if (titleSimilarity(pick.p.title, posting.title || pick.p.title) < 0.8) { reason = 'posting title differs'; continue; }
    return { facts: { ...posting, via: `oracle ${site.host}/${site.siteNumber} (${site.via}${pick.m.reqMatch ? ', req match' : ''})` }, reason: 'ok' };
  }
  return { facts: null, reason };
}

// ── iCIMS ────────────────────────────────────────────────────────────

export function buildIcimsIndex(slugs) {
  const byTenant = new Map();
  for (const s of slugs || []) {
    const t = String(s).toLowerCase();
    if (/^[a-z0-9][a-z0-9-]*$/.test(t)) byTenant.set(t, t);
  }
  return { byTenant };
}

export function icimsSearchUrl(origin, title) {
  return `${origin}/jobs/search?ss=1&searchKeyword=${encodeURIComponent(String(title).slice(0, 100))}&in_iframe=1`;
}

export async function verifyViaIcims(job, { fetchText, index, trackedCompanies = [], now = Date.now() }) {
  if (typeof fetchText !== 'function') return { facts: null, reason: 'no text fetcher' };
  const origins = [];
  for (const e of trackedCompanies || []) {
    if (e?.enabled === false || !/\.icims\.com/i.test(String(e?.careers_url || ''))) continue;
    if (employerMatches(job.company, e.name) || compactCompany(job.company) === compactCompany(e.name)) {
      try { origins.push({ origin: new URL(e.careers_url).origin, via: 'tracked' }); } catch { /* skip */ }
    }
  }
  const tenant = index?.byTenant?.get(compactCompany(job.company));
  if (tenant) for (const host of icimsHostCandidates(tenant)) origins.push({ origin: `https://${host}`, via: 'tenant list' });
  if (!origins.length) return { facts: null, reason: 'employer not found in the iCIMS tenant list' };

  let reason = 'no match';
  for (const { origin, via } of origins.slice(0, 3)) {
    const html = await fetchText(icimsSearchUrl(origin, job.title));
    if (!html) { reason = `no response from ${origin}`; continue; }
    const cards = parseIcimsSearchPage(html, origin, job.company).map((c) => ({
      title: c.title, locationsText: c.location || '', externalPath: c.url, bulletFields: [(c.url.match(/\/jobs\/(\d+)/) || [])[1]].filter(Boolean),
    }));
    if (!cards.length) { reason = `no matching postings on ${origin}`; continue; }
    const { pick, reason: why } = pickUnique(job, cards);
    if (!pick) { reason = why; continue; }
    const posting = await fetchIcimsPosting(pick.p.externalPath, fetchText, now);
    if (!posting) { reason = 'posting has no structured data'; continue; }
    // Employer: tenant-list matches must be confirmed by the posting's own hiringOrganization.
    if (via !== 'tracked' && !(posting.org && employerMatches(job.company, posting.org))) {
      reason = posting.org ? `employer mismatch (iCIMS says "${posting.org}")` : 'employer not confirmable';
      continue;
    }
    if (posting.title && titleSimilarity(pick.p.title, posting.title) < 0.8) { reason = 'posting title differs'; continue; }
    return { facts: { ...posting, via: `icims ${origin} (${via}${pick.m.reqMatch ? ', req match' : ''})` }, reason: 'ok' };
  }
  return { facts: null, reason };
}
