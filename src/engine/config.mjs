// config.mjs — scan settings. Defaults here; overrides from the `discovery:`
// block in config/profile.yml. Guardrails are CLAMPED: no config value can
// raise them past LIMITS (see docs/GUARDRAILS.md).
//
// Files (relative to the project root, see src/paths.mjs):
//   config/profile.yml     candidate profile + discovery settings
//   config/portals.yml     tracked companies, title and location filters
//   config/cv.md           optional; skills are read from it when profile.yml has no `skills:`
//   config/blacklist.md    optional do-not-apply list
//   state/                 first-seen store, rotation cursor, caches (kept between runs)
//   output/                per-scan reports
import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { projectRoot } from '../paths.mjs';
import { DEFAULT_PRESETS, DEFAULT_COMPANY_BOARDS, resolvePreset } from './presets.mjs';
import { normalizeProfile } from './profile.mjs';

export const LIMITS = Object.freeze({
  maxWorkers: 3,
  softMs: 180_000,          // 3 min: stop new work, return partial
  hardMs: 300_000,          // 5 min: abort everything
  maxTopN: 10,
  maxShortlist: 15,
  maxJdFetch: 25,
  maxConcurrency: 8,
  maxRequestTimeoutMs: 8000,
  maxScanCapUsd: 0.25,      // never above without explicit approval
});

export const DEFAULTS = Object.freeze({
  windowHours: 24,
  sourceBudgetMs: 90_000,   // sources stop here so enrichment fits the 2-min target
  softMs: 180_000,
  hardMs: 300_000,
  topN: 10,
  shortlistMax: 15,
  jdFetchMax: 25,
  jdConcurrency: 8,
  requestTimeoutMs: 8000,
  boardConcurrency: 6,
  perBoardMs: 20_000,
  rotationBatch: 25,
  strongFit: 4.0,
  sources: { tracked: true, 'ats-rotation': true, apify: true, 'company-boards': false },
  rotationAts: ['greenhouse', 'lever', 'ashby'], // presets may narrow (startup → ashby, lever)
  // Free US-relevant public job boards (public APIs / RSS, no login). Read by
  // the tracked worker as DISCOVERY-ONLY aggregators: every job still needs
  // employer verification before it can be shown. Excluded on purpose: boards
  // that require login or prohibit automated access (Handshake, Meta careers,
  // Experis), EchoJobs (feed retired), and non-US boards.
  includePublicBoards: true,
  publicBoards: [
    { name: 'Built In', provider: 'builtin', builtin: { categories: ['data-analytics'], max_pages: 2 } }, // category pages only: robots.txt disallows /jobs?search=
    { name: 'The Muse', provider: 'themuse' },
    { name: 'HN Who is Hiring', provider: 'hackernews' },
    { name: 'a16z Speedrun', provider: 'a16z-speedrun-talent', careers_url: 'https://speedrun-talent-network.com' },
    { name: 'Agentic Jobs', provider: 'agentic-jobs' },
    { name: 'RemoteOK', provider: 'remoteok' },
    { name: 'Remotive', provider: 'remotive' },
    { name: 'Himalayas', provider: 'himalayas' },
    { name: 'Jobicy', provider: 'jobicy' },
    { name: 'We Work Remotely', provider: 'weworkremotely' },
    { name: 'Working Nomads', provider: 'workingnomads' },
    { name: 'NoDesk', provider: 'nodesk' },
    { name: 'Jobspresso', provider: 'jobspresso' },
    { name: '4dayweek', provider: '4dayweek' },
  ],
  trackedCategory: null,                         // presets may restrict tracked entries by `category:`
  apify: {
    enabled: true,
    companyNames: [],         // company presets: LinkedIn discovery restricted to these employers
    scanCapUsd: 0.10,
    warnUsd: 0.08,
    perRunCapUsd: 0.01,
    maxConcurrentRuns: 4,
    runTimeoutMs: 75_000,
    pollMs: 3000,
    costRetryMs: 1500,        // one re-read if charges lag the run's terminal status
    nextWaveBeforeMs: 45_000,
    queries: {
      primary: ['AI Engineer', 'Machine Learning Engineer', 'Data Scientist'],
      secondary: ['Data Engineer', 'Data Analyst'],
      adjacent: ['Business Analyst'],
    },
    // Fallback prices, used only if Apify's exact charges can't be read back.
    // Observed 2026-10-11: $0.001 per run start; $0.0004 (LinkedIn) /
    // $0.0001 (Indeed) per result — kept slightly above observed on purpose.
    actors: {
      linkedin: { actor: 'valig/linkedin-jobs-scraper', limitPerQuery: 15, pricePerItemUsd: 0.0005, startUsd: 0.001 },
      indeed: { actor: 'valig/indeed-jobs-scraper', limitPerQuery: 15, pricePerItemUsd: 0.00015, startUsd: 0.001, input: { country: 'us', datePosted: '1' } },
    },
  },
});

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));

export function applyLimits(c) {
  c.softMs = clamp(c.softMs, 10_000, LIMITS.softMs);
  c.hardMs = clamp(c.hardMs, c.softMs, LIMITS.hardMs);
  c.sourceBudgetMs = clamp(c.sourceBudgetMs, 5_000, c.softMs);
  c.topN = clamp(c.topN, 1, LIMITS.maxTopN);
  c.shortlistMax = clamp(c.shortlistMax, c.topN, LIMITS.maxShortlist);
  c.jdFetchMax = clamp(c.jdFetchMax, 0, LIMITS.maxJdFetch);
  c.jdConcurrency = clamp(c.jdConcurrency, 1, LIMITS.maxConcurrency);
  c.boardConcurrency = clamp(c.boardConcurrency, 1, LIMITS.maxConcurrency);
  c.requestTimeoutMs = clamp(c.requestTimeoutMs, 1000, LIMITS.maxRequestTimeoutMs);
  c.perBoardMs = clamp(c.perBoardMs, 2000, 60_000);
  c.rotationBatch = clamp(c.rotationBatch, 0, 50);
  const a = c.apify;
  a.scanCapUsd = clamp(a.scanCapUsd, 0, LIMITS.maxScanCapUsd);
  a.perRunCapUsd = clamp(a.perRunCapUsd, 0, a.scanCapUsd);
  a.warnUsd = clamp(a.warnUsd, 0, a.scanCapUsd);
  a.maxConcurrentRuns = clamp(a.maxConcurrentRuns, 1, 6);
  a.runTimeoutMs = clamp(a.runTimeoutMs, 10_000, c.softMs);
  for (const act of Object.values(a.actors)) act.limitPerQuery = clamp(act.limitPerQuery, 1, 50);
  // At most 3 parallel workers, ever.
  const on = Object.entries(c.sources).filter(([, v]) => v).map(([k]) => k).slice(0, LIMITS.maxWorkers);
  c.sources = Object.fromEntries(Object.keys(c.sources).map((k) => [k, on.includes(k)]));
  return c;
}

/**
 * Config for a preset command ("run", "faang", "company Amazon", …): the
 * preset's overrides, then `extra` (CLI flags win), then the usual LIMITS
 * clamp — a preset can never loosen a guardrail.
 */
export function loadConfigForPreset(command = 'run', extra = {}, opts = {}) {
  const base = loadConfig({}, opts);
  const p = resolvePreset(command, base.presets);
  const c = loadConfig(deepMerge(p.overrides || {}, extra), opts);
  c.preset = { name: p.name, description: p.description || '' };
  c.filters = p.filters || {};
  return c;
}

export function loadConfig(overrides = {}, { root = projectRoot() } = {}) {
  let fromProfile = {};
  let profile = {};
  try {
    profile = yaml.load(fs.readFileSync(path.join(root, 'config/profile.yml'), 'utf8')) || {};
    if (isObj(profile?.discovery)) fromProfile = profile.discovery;
  } catch { /* defaults */ }
  // Presets / company boards: defaults, then profile.yml additions (per name).
  const { presets: profilePresets, companyBoards: profileBoards, ...rest } = fromProfile;
  fromProfile = rest;
  const c = deepMerge(deepMerge(structuredClone(DEFAULTS), fromProfile), overrides);
  c.presets = { ...structuredClone(DEFAULT_PRESETS) };
  for (const [k, v] of Object.entries(isObj(profilePresets) ? profilePresets : {})) c.presets[k] = isObj(v) ? { ...(c.presets[k] || {}), ...v } : v;
  c.companyBoards = { ...structuredClone(DEFAULT_COMPANY_BOARDS), ...(isObj(profileBoards) ? profileBoards : {}) };
  c.paths = {
    root,
    portals: path.join(root, 'config/portals.yml'),
    cv: path.join(root, 'config/cv.md'),
    blacklist: path.join(root, 'config/blacklist.md'),
    // Optional career-ops interop: point these at a career-ops checkout to treat
    // its scan history and tracker rows as already seen.
    history: path.join(root, 'state/scan-history.tsv'),
    tracker: path.join(root, 'state/applications.md'),
    deadBoards: path.join(root, 'state/dead-boards.tsv'), // read-only here
    outDir: path.join(root, 'output'),
    ...(c.paths || {}),
  };
  c.stateFile = c.stateFile || path.join(root, 'state/discovery-state.json');
  c.seenFile = c.seenFile || path.join(root, 'state/job-seen.json');
  c.atsCacheDir = c.atsCacheDir || path.join(root, 'state/cache/ats-companies');
  c.profile = normalizeProfile(profile);
  c.raw = { alerts: profile.alerts || {}, ai: profile.ai || {}, candidate: profile.candidate || {} };
  return applyLimits(c);
}
