// sources/company-boards.mjs — the official job boards of specific companies,
// for company-scoped presets (faang, staffing, company <name>). One more
// source for runFreshScan(), not a separate scanner: boards are scanned by the
// same provider modules and runBoards() as tracked companies.
//
// A company's board is used only when it is known to be that company's:
//   1. configured   discovery.companyBoards (e.g. Amazon → amazon.jobs)
//   2. tracked      a portals.yml entry whose name matches the company
//   3. Greenhouse   board slug = company name AND the board's own name matches
//   4. Workday      tenant = company name AND a posting document's
//                   hiringOrganization names the same employer
// Nothing else (no prefix/acronym guesses for scanning). Companies with no
// confirmable official board are reported as unresolved — their LinkedIn hits
// can still be verified per job, or are excluded by the strict gate.
import { resolveProvider } from '../../vendor/providers/_registry.mjs';
import { SOURCES } from '../../vendor/ats-datasets.mjs';
import { runBoards } from '../boards.mjs';
import { employerMatches, compactCompany } from '../match.mjs';

export async function confirmGreenhouseBoard(company, fetchJson) {
  const slug = compactCompany(company);
  if (slug.length < 3) return null;
  const board = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
  if (!board?.name || !employerMatches(company, board.name)) return null;
  return { name: company, careers_url: `https://job-boards.greenhouse.io/${slug}` };
}

export async function confirmWorkdayTenant(company, index, fetchJson, searchText = 'engineer') {
  const t = compactCompany(company);
  const boards = index?.byTenant?.get(t) || [];
  const out = [];
  for (const b of boards.slice(0, 2)) {
    const cxs = `https://${b.tenant}.${b.instance}.myworkdayjobs.com/wday/cxs/${b.tenant}/${b.site}`;
    const list = await fetchJson(`${cxs}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText }) });
    const first = list?.jobPostings?.find((p) => typeof p?.externalPath === 'string' && p.externalPath.startsWith('/job/'));
    if (!first) continue;
    const org = (await fetchJson(`${cxs}${first.externalPath}`))?.hiringOrganization?.name || '';
    if (org && employerMatches(company, org)) {
      out.push({ name: company, careers_url: `https://${b.tenant}.${b.instance}.myworkdayjobs.com/${b.site}` });
    }
  }
  return out;
}

/**
 * @returns {Promise<{boards: Array<{entry, provider, key, via}>, unresolved: string[]}>}
 */
export async function resolveCompanyBoards(companies, ctx) {
  const { portals, providers, config, fetchJson, workdayIndex } = ctx;
  const configured = config.companyBoards || {};
  const boards = [];
  const unresolved = [];
  const add = (entry, via) => {
    const r = resolveProvider(entry, providers, { skipIds: ['local-parser'] });
    if (!r?.provider) return false;
    boards.push({ entry, provider: r.provider, key: `company:${entry.name}:${entry.careers_url}:${boards.length}`, via });
    return true;
  };
  for (const company of companies) {
    let found = 0;
    for (const [name, entries] of Object.entries(configured)) {
      if (!employerMatches(company, name) && name.toLowerCase() !== company.toLowerCase()) continue;
      for (const e of entries || []) if (add({ ...e, name: company }, 'configured')) found++;
    }
    for (const e of portals.tracked_companies || []) {
      if (e?.enabled === false || e?.scan_method === 'websearch' || !e?.careers_url) continue;
      if (employerMatches(company, e.name) || compactCompany(e.name) === compactCompany(company)) {
        if (add({ ...e, name: company }, 'tracked')) found++;
      }
    }
    if (!found) {
      const gh = await confirmGreenhouseBoard(company, fetchJson).catch(() => null);
      if (gh && add(gh, 'greenhouse (board name confirmed)')) found++;
    }
    if (!found && workdayIndex) {
      for (const wd of await confirmWorkdayTenant(company, workdayIndex, fetchJson).catch(() => [])) {
        boards.push({ entry: wd, provider: SOURCES.workday.provider, key: `company:${company}:${wd.careers_url}`, via: 'workday (employer confirmed)' });
        found++;
      }
    }
    if (!found) unresolved.push(company);
  }
  return { boards, unresolved };
}

export default {
  id: 'company-boards',
  async run(ctx) {
    const companies = ctx.filters?.companies || [];
    if (!companies.length) return { skipped: 'no companies in this preset' };
    const { boards, unresolved } = await resolveCompanyBoards(companies, ctx);
    const res = await runBoards(boards, {
      signal: ctx.signal, emit: ctx.emit, source: 'company-boards', prefilter: ctx.prefilter,
      concurrency: ctx.config.boardConcurrency, perBoardMs: ctx.config.perBoardMs, httpCtx: ctx.httpCtx,
    });
    return {
      companies, boards: boards.map((b) => ({ company: b.entry.name, via: b.via, url: b.entry.careers_url })),
      unresolved, done: res.done.length, failed: res.failed.length, unfinished: res.unfinished.length, jobs: res.jobs, failures: res.failures,
    };
  },
};
