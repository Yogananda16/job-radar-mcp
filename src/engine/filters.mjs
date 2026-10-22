// filters.mjs — preset result filters (applied as hard filters, before
// scoring, inside the shared pipeline). They only ever REMOVE jobs.
import { employerMatches, compactCompany } from './match.mjs';
import { companyKey } from './job.mjs';

const STATE_ALIASES = {
  connecticut: { abbr: 'CT', cities: ['Stamford', 'Hartford', 'New Haven', 'West Haven', 'Norwalk', 'Greenwich', 'Bridgeport', 'Danbury', 'Shelton', 'Westport', 'Milford', 'Glastonbury'] },
  'new york': { abbr: 'NY', cities: ['New York City', 'NYC', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'White Plains', 'Albany', 'Rochester', 'Buffalo', 'Long Island', 'Purchase', 'Armonk', 'Tarrytown'] },
  'new jersey': { abbr: 'NJ', cities: ['Jersey City', 'Newark', 'Hoboken', 'Princeton', 'Morristown', 'Parsippany', 'Edison', 'Iselin', 'Basking Ridge', 'Bridgewater', 'Piscataway', 'Weehawken'] },
  massachusetts: { abbr: 'MA', cities: ['Boston', 'Cambridge', 'Somerville', 'Waltham', 'Burlington', 'Lexington', 'Woburn', 'Needham', 'Framingham', 'Worcester', 'Quincy'] },
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildLocalMatcher(locations) {
  const parts = [];
  for (const raw of locations || []) {
    const name = String(raw).trim();
    if (!name) continue;
    parts.push(esc(name));
    const a = STATE_ALIASES[name.toLowerCase()];
    if (a) {
      parts.push(...a.cities.map(esc));
      // "Hartford, CT" / "CT, US" / "US-CT" — the abbreviation as a separate token, upper case only
      parts.push(`(?:^|[,\\s(/-])${a.abbr}(?=$|[,\\s)/-])`);
    }
  }
  if (!parts.length) return () => false;
  const named = new RegExp(parts.filter((p) => !p.startsWith('(?:^')).join('|'), 'i');
  const abbr = parts.filter((p) => p.startsWith('(?:^')).map((p) => new RegExp(p)); // case-sensitive
  return (loc) => {
    const s = String(loc || '');
    return named.test(s) || abbr.some((re) => re.test(s));
  };
}

// "Remote" with nothing pointing outside the US (the portals.yml location
// filter already removes non-US locations; this only checks the remote part).
export function isUsRemote(job) {
  const loc = String(job.location || '');
  if (!(job.remote || /\bremote\b|\banywhere in the u\.?s|\bwork from home\b/i.test(loc))) return false;
  return !/\b(canada|uk|united kingdom|europe|emea|apac|india|mexico|brazil|germany|latam|philippines)\b/i.test(loc);
}

// Result scoping only (never used to verify an employer): the same employer,
// or a division whose name starts with the company as a whole word —
// "Amazon Web Services" ∈ Amazon; "Applebee's" ∉ Apple; "Metabase" ∉ Meta.
export function inCompanyFamily(company, jobCompany) {
  if (employerMatches(company, jobCompany) || compactCompany(company) === compactCompany(jobCompany)) return true;
  const want = companyKey(company).split(' ').filter(Boolean);
  const have = companyKey(jobCompany).split(' ').filter(Boolean);
  if (!want.length || want.join('').length < 3 || have.length < want.length) return false;
  return want.every((w, i) => have[i] === w);
}

/**
 * @returns {(job) => string|null}  null = keep, otherwise the exclusion reason
 */
export function buildPresetFilter(filters = {}) {
  const checks = [];
  if (Array.isArray(filters.companies) && filters.companies.length) {
    const wanted = filters.companies;
    checks.push((job) => wanted.some((c) => inCompanyFamily(c, job.company)) ? null : 'outside preset companies');
  }
  if (filters.location === 'remote') {
    checks.push((job) => (isUsRemote(job) ? null : 'not remote (US)'));
  } else if (filters.location === 'local') {
    const local = buildLocalMatcher(filters.locations);
    const allowRemote = filters.includeRemote !== false;
    checks.push((job) => (local(job.location) || (allowRemote && isUsRemote(job)) ? null : 'outside local area'));
  }
  return (job) => {
    for (const c of checks) { const r = c(job); if (r) return r; }
    return null;
  };
}
