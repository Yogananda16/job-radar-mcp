// ats-datasets.mjs: the public ATS company directories that the rotation
// source walks, plus how to turn one directory entry into a board the matching
// provider can fetch.
//
// Adapted from career-ops' scan-ats-full.mjs (MIT, see LICENSE-career-ops):
// only the SOURCES table and its two helpers. The sweep, CLI and tracker code
// from that file are not needed here.
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import ashby from './providers/ashby.mjs';
import workday from './providers/workday.mjs';
import icims from './providers/icims.mjs';

// Community-maintained directory of public ATS boards.
export const DATASET_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

// Directory entries are external input destined for URL interpolation, so
// anything outside a conservative slug charset is rejected.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// Part of the upstream Workday list has an instance name ("wd5") where the
// tenant should be. None of those hosts resolve.
const WORKDAY_JUNK_TENANT_RE = /^wd\d+$/i;

// SSRF guard: a constructed careers_url must resolve to the expected ATS host
// before it reaches provider.fetch. Returns the entry, or null.
export function entryOnHost(name, careersUrl, isCanonicalHost) {
  let hostname;
  try {
    ({ hostname } = new URL(careersUrl));
  } catch {
    return null;
  }
  return isCanonicalHost(hostname) ? { name, careers_url: careersUrl } : null;
}

// iCIMS directory entries are sometimes a bare tenant ("acme", served at
// careers-acme.icims.com) and sometimes the full subdomain ("careers-acme").
// Returns the likelier host first and the other shape as a fallback.
export function icimsHostCandidates(slug) {
  const s = String(slug ?? '').toLowerCase().replace(/^-+/, '');
  if (!s) return [];
  const asIs = `${s}.icims.com`;
  const prefixed = `careers-${s}.icims.com`;
  if (s.startsWith('careers-')) return [asIs];
  return s.includes('careers') ? [asIs, prefixed] : [prefixed, asIs];
}

const onHost = (host) => (h) => h === host;

export const SOURCES = {
  greenhouse: {
    provider: greenhouse,
    dataset: `${DATASET_BASE}/greenhouse_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://job-boards.greenhouse.io/${slug}`, onHost('job-boards.greenhouse.io'))
      : null,
  },
  lever: {
    provider: lever,
    dataset: `${DATASET_BASE}/lever_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.lever.co/${slug}`, onHost('jobs.lever.co'))
      : null,
  },
  ashby: {
    provider: ashby,
    dataset: `${DATASET_BASE}/ashby_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.ashbyhq.com/${slug}`, onHost('jobs.ashbyhq.com'))
      : null,
  },
  workday: {
    provider: workday,
    dataset: `${DATASET_BASE}/workday_companies.json`,
    // Entries are "tenant|instance|site" triples.
    toEntry: (line) => {
      const [tenant, instance, site] = String(line).split('|');
      if (![tenant, instance, site].every((p) => p && SLUG_RE.test(p))) return null;
      if (WORKDAY_JUNK_TENANT_RE.test(tenant)) return null;
      const host = `${tenant}.${instance}.myworkdayjobs.com`;
      return entryOnHost(tenant, `https://${host}/${site}`, onHost(host));
    },
  },
  icims: {
    provider: icims,
    dataset: `${DATASET_BASE}/icims_companies.json`,
    toEntry: (slug) => {
      if (!SLUG_RE.test(String(slug))) return null;
      const hosts = icimsHostCandidates(slug);
      if (hosts.length === 0) return null;
      const [primary, ...fallbacks] = hosts.map((h) => `https://${h}/jobs/search?ss=1&in_iframe=1`);
      const entry = entryOnHost(String(slug), primary, onHost(hosts[0]));
      if (entry && fallbacks.length) entry.fallback_urls = fallbacks;
      return entry;
    },
  },
};
