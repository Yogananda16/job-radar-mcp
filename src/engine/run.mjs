// run.mjs — runFreshScan(): the whole discovery pipeline, as one function.
//
//   sources (≤3 workers) → normalize → dedup → first-seen / repost check
//   → freshness ≤24h → hard filters + eligibility gate → fit score
//   → job text for the top 25 → employer verification for the shortlist (≤15)
//   → Top 10
//
// Zero LLM. Callable from the CLI (src/cli.mjs), the alert runner (src/main.mjs)
// or the MCP server — Claude Code is not needed to run a scan. Every network call
// is bounded (8s) and tied to the scan's deadlines; nothing outlives the call.
import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { loadConfig } from './config.mjs';
import { createClock, makeFetchJson, makeFetchText, pool, abortPromise, CostLedger } from './runtime.mjs';
import { SeenStore } from './seen-store.mjs';
import { classifyFreshness, freshnessAllowsFinal, freshnessAllowsCandidate, freshnessRank, STATUS, DAY } from './freshness.mjs';
import { checkEligibility } from './eligibility.mjs';
import { DEFAULT_PROFILE } from './profile.mjs';
import { scoreJob, loadCvSkillsFile, compileSkills } from './score.mjs';
import { identityKeys, ctlKey, companyKey, titleKey, isEmployerUrl, verifiedApplyUrl, EVIDENCE, CREDIBLE_EVIDENCE } from './job.mjs';
import { fetchAtsPosting, employerAtsKind, verifyAtEmployer, boardFromCareersUrl } from './ats.mjs';
import { boundedHttpCtx } from './boards.mjs';
import { buildWorkdayIndex, verifyViaWorkday } from './workday-verify.mjs';
import { verifyViaOracle, verifyViaIcims, buildIcimsIndex } from './oracle-icims-verify.mjs';
import { buildPresetFilter } from './filters.mjs';
import { renderMarkdown } from './report.mjs';
import { fileURLToPath } from 'url';

const PROVIDERS_DIR = fileURLToPath(new URL('../vendor/providers/', import.meta.url));

// ── dedup ─────────────────────────────────────────────────────────────

function better(a, b) {
  // Prefer the observation with credible (employer) timing, then the one with text.
  const ra = CREDIBLE_EVIDENCE.has(a.postedEvidence) ? 2 : a.postedAt ? 1 : 0;
  const rb = CREDIBLE_EVIDENCE.has(b.postedEvidence) ? 2 : b.postedAt ? 1 : 0;
  if (ra !== rb) return ra > rb ? a : b;
  return (a.description?.length || 0) >= (b.description?.length || 0) ? a : b;
}

export function mergeJobs(a, b) {
  const keep = better(a, b);
  const other = keep === a ? b : a;
  return {
    ...keep,
    employerUrl: keep.employerUrl || other.employerUrl,
    requisitionId: keep.requisitionId || other.requisitionId,
    sourceRepost: keep.sourceRepost || other.sourceRepost, // either source flagging a repost counts
    company: keep.company || other.company,
    // A live board listing from either observation proves the posting is open;
    // a closed posting document from either withdraws it.
    liveVerified: (keep.liveVerified || other.liveVerified) && !(keep.closedAtEmployer || other.closedAtEmployer),
    liveVia: keep.liveVia || other.liveVia || '',
    closedAtEmployer: Boolean(keep.closedAtEmployer || other.closedAtEmployer),
    description: keep.description || other.description,
    salary: keep.salary || other.salary,
    remote: keep.remote || other.remote,
    // The aggregator's displayed time survives the merge: a fresh listing on top
    // of an old employer date is exactly the repost signal.
    listedAt: [keep.listedAt, other.listedAt].filter(Number.isFinite).sort((x, y) => y - x)[0] ?? null,
    alsoSeenOn: [...new Set([...(keep.alsoSeenOn || []), ...(other.alsoSeenOn || []), other.source])].filter((s) => s !== keep.source),
    mergedIds: [...new Set([...(keep.mergedIds || []), ...(other.mergedIds || []), ...identityKeys(other)])],
  };
}

export class Deduper {
  constructor() { this.byKey = new Map(); this.jobs = new Set(); }
  keysOf(job) {
    const ks = [...identityKeys(job), ...(job.mergedIds || [])];
    const c = ctlKey(job);
    if (c) ks.push(c);
    return ks;
  }
  add(job) {
    const hits = new Set();
    for (const k of this.keysOf(job)) { const j = this.byKey.get(k); if (j) hits.add(j); }
    let merged = job;
    for (const h of hits) { merged = mergeJobs(h, merged); this.jobs.delete(h); }
    this.jobs.add(merged);
    for (const k of this.keysOf(merged)) this.byKey.set(k, merged);
    for (const h of hits) for (const k of this.keysOf(h)) this.byKey.set(k, merged);
    return merged;
  }
  all() { return [...this.jobs]; }
}

// ── user-layer inputs ─────────────────────────────────────────────────

export function trackerRoleKeys(trackerText) {
  const keys = new Set();
  const lines = String(trackerText || '').split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  if (!lines.length) return keys;
  const header = lines[0].split('|').map((s) => s.trim().toLowerCase());
  const ci = header.indexOf('company'); const ri = header.indexOf('role');
  if (ci < 0 || ri < 0) return keys;
  for (const l of lines.slice(1)) {
    const cells = l.split('|').map((s) => s.trim());
    if (/^[-: ]+$/.test(cells[ci] || '')) continue;
    const k = `${companyKey(cells[ci])}|${titleKey(cells[ri])}`;
    if (k !== '|') keys.add(k);
  }
  return keys;
}

async function loadDeps(config, opts) {
  const deps = { ...(opts.deps || {}) };
  if (!deps.portals) deps.portals = yaml.load(fs.readFileSync(config.paths.portals, 'utf8')) || {};
  if (!deps.titleFilter) {
    const { buildTitleFilter } = await import('../vendor/title-keywords.mjs');
    deps.titleFilter = deps.portals.title_filter ? buildTitleFilter(deps.portals.title_filter) : () => true;
  }
  if (!deps.locationFilter || !deps.blacklist) {
    const scan = await import('../vendor/scan-filters.mjs');
    deps.locationFilter ||= scan.buildLocationFilter(deps.portals.location_filter);
    deps.blacklist ||= scan.loadBlacklist(config.paths.blacklist);
    deps.findBlacklistEntry ||= scan.findBlacklistEntry;
  }
  deps.findBlacklistEntry ||= () => null;
  if (!deps.trackerKeys) {
    try { deps.trackerKeys = trackerRoleKeys(fs.readFileSync(config.paths.tracker, 'utf8')); } catch { deps.trackerKeys = new Set(); }
  }
  if (!deps.profile) deps.profile = config.profile || DEFAULT_PROFILE;
  if (!deps.skills) deps.skills = compileSkills(deps.profile.skills || loadCvSkillsFile(config.paths.cv));
  if (!deps.store) deps.store = SeenStore.load(config.seenFile, { historyPath: config.paths.history });
  // Provider modules are needed by every source that scans boards in-process.
  if (!deps.providers && (config.sources.tracked || config.sources['company-boards'])) {
    const { loadProviders } = await import('../vendor/providers/_registry.mjs');
    deps.providers = await loadProviders(PROVIDERS_DIR);
  }
  if (!deps.sources) {
    const mods = {
      tracked: () => import('./sources/tracked.mjs'),
      'ats-rotation': () => import('./sources/ats-rotation.mjs'),
      'company-boards': () => import('./sources/company-boards.mjs'),
      apify: () => import('./sources/apify.mjs'),
    };
    deps.sources = [];
    for (const [id, on] of Object.entries(config.sources)) if (on && mods[id]) deps.sources.push((await mods[id]()).default);
  }
  if (!deps.trackedBoards) {
    deps.trackedBoards = new Map();
    for (const e of deps.portals.tracked_companies || []) {
      const b = boardFromCareersUrl(e?.careers_url);
      if (b && e.name) deps.trackedBoards.set(companyKey(e.name), b);
    }
  }
  return deps;
}

// Public Workday tenant list — the same file scan-ats-full.mjs caches
// (state/cache/ats-companies/workday.json). Read from cache; downloaded once
// (bounded, 8s request cap) only if the cache is missing. Tracked Workday
// boards from portals.yml are added with their known company name.
const WD_CAREERS_RE = /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/;
export async function loadWorkdayIndex(config, deps, fetchJson) {
  const file = path.join(config.atsCacheDir, 'workday.json');
  let lines = null;
  try { lines = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
  if (!Array.isArray(lines)) {
    try {
      const { SOURCES } = await import('../vendor/ats-datasets.mjs');
      const got = await fetchJson(SOURCES.workday.dataset);
      if (Array.isArray(got)) {
        lines = got;
        try { fs.mkdirSync(config.atsCacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(got)); } catch { /* cache optional */ }
      }
    } catch { /* unavailable */ }
  }
  const tracked = [];
  for (const e of deps.portals?.tracked_companies || []) {
    const m = String(e?.careers_url || '').match(WD_CAREERS_RE);
    if (m && e.name && m[3] !== 'wday') tracked.push({ tenant: m[1], instance: m[2], site: m[3], company: e.name });
  }
  if (!Array.isArray(lines) && !tracked.length) return null;
  return buildWorkdayIndex(lines || [], tracked);
}

// Public iCIMS tenant list (same cache scan-ats-full.mjs uses); downloaded once
// (bounded) only if the cache is missing.
export async function loadIcimsIndex(config, fetchJson) {
  const file = path.join(config.atsCacheDir, 'icims.json');
  let slugs = null;
  try { slugs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
  if (!Array.isArray(slugs)) {
    try {
      const { SOURCES } = await import('../vendor/ats-datasets.mjs');
      const got = await fetchJson(SOURCES.icims.dataset);
      if (Array.isArray(got)) {
        slugs = got;
        try { fs.mkdirSync(config.atsCacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(got)); } catch { /* optional */ }
      }
    } catch { /* unavailable */ }
  }
  return Array.isArray(slugs) ? buildIcimsIndex(slugs) : null;
}

// ── evaluation ────────────────────────────────────────────────────────

function evaluate(job, ctx) {
  const seen = ctx.store.lookup(job);
  const fresh = classifyFreshness(job, seen, ctx.now, ctx.windowMs);
  const profile = ctx.profile || DEFAULT_PROFILE;
  const elig = checkEligibility(job, profile);
  const score = scoreJob(job, elig, ctx.skills, profile);
  return { job, fresh, elig, score };
}

// Facts read from the employer's own ATS. Only a credible employer date
// (exact ATS time, or a day-only employer date) replaces the posting time —
// an aggregator time is never promoted here. The requisition id joins the
// job's identity, so a re-release of a req seen before is caught as SEEN.
export function applyEmployerFacts(job, got) {
  if (got.requisitionId && !job.requisitionId) job.requisitionId = String(got.requisitionId);
  if (CREDIBLE_EVIDENCE.has(got.evidence) && Number.isFinite(got.postedAt)) {
    job.postedAt = got.postedAt;
    job.postedEvidence = got.evidence;
    job.postedDay = got.postedDay || '';
  }
  // Live official page: only when the employer's own ATS returned the posting
  // as open. An employer site we cannot read (live: false/undefined) proves nothing.
  if (got.closed === true) {
    // The employer's posting document says it is closed (Workday canApply:false,
    // SmartRecruiters active:false) — this withdraws any earlier live proof.
    job.liveVerified = false;
    job.closedAtEmployer = true;
  } else if (got.live === true && isEmployerUrl(got.employerUrl)) {
    job.liveVerified = true;
    job.employerUrl = got.employerUrl;
    job.liveVia = got.via || 'employer ATS posting';
  }
  return job;
}

// STRICT FINAL GATE (docs/GUARDRAILS.md). Returns null when the job may be
// shown, otherwise the exclusion reason. Only NEW + live employer page +
// employer/ATS apply link + not BLOCKED passes; nothing else is ever shown.
export function finalGateReason(ev) {
  const s = ev.fresh.status;
  if (s === STATUS.SEEN) return 'seen before';
  if (s === STATUS.POSSIBLE_REPOST) return 'possible repost';
  if (s === STATUS.STALE) return 'older than 24h';
  if (s === STATUS.VERIFY) return 'original freshness unverifiable';
  if (!freshnessAllowsFinal(ev.fresh)) return 'not new';
  if (ev.elig.eligibility === 'BLOCKED') return 'eligibility blocked';
  if (ev.job.closedAtEmployer) return 'closed at employer';
  if (!ev.job.liveVerified) return 'no live employer page verified';
  if (!verifiedApplyUrl(ev.job)) return 'aggregator-only apply link';
  return null;
}

// Hard filters → first-seen/freshness → eligibility gate. Pushes every
// evaluated job into `evaluated`; returns the ranked candidates.
function filterAndEvaluate(jobs, deps, ctx, evaluated, bump) {
  const candidates = [];
  for (const job of jobs) {
    // No employer name (Indeed-hosted / agency posts): a legitimacy red flag,
    // never a gap to fill in — excluded and counted, never guessed.
    if (!companyKey(job.company)) { bump('employer hidden'); continue; }
    // Preset filters (companies / remote / local) — they only ever remove jobs.
    const presetWhy = ctx.presetFilter ? ctx.presetFilter(job) : null;
    if (presetWhy) { bump(presetWhy); continue; }
    if (!deps.locationFilter(job.location, job.url, job.title)) { bump('location filter'); continue; }
    if (deps.findBlacklistEntry(deps.blacklist, job.company, job.employerUrl || job.url)) { bump('blacklist'); continue; }
    if (deps.trackerKeys.has(`${companyKey(job.company)}|${titleKey(job.title)}`)) { bump('already in tracker'); continue; }
    const ev = evaluate(job, ctx);
    evaluated.push(ev);
    if (!freshnessAllowsCandidate(ev.fresh)) {
      const why = ev.fresh.status === STATUS.VERIFY ? 'no reliable date'
        : ev.fresh.status === STATUS.SEEN ? 'seen before'
        : ev.fresh.status === STATUS.POSSIBLE_REPOST ? 'possible repost' : 'older than 24h';
      bump(why);
      continue;
    }
    if (ev.elig.eligibility === 'BLOCKED') { bump('eligibility blocked'); continue; }
    candidates.push(ev);
  }
  return candidates.sort(byRank);
}

function isStrong(ev, cfg) {
  return finalGateReason(ev) === null
    && ev.elig.eligibility === 'OK'
    && ev.score.fit >= cfg.strongFit;
}

function rankKey(ev) {
  return [freshnessRank(ev.fresh), -ev.score.fit, -(ev.fresh.originalAt || ev.job.listedAt || 0)];
}
function byRank(a, b) {
  const ka = rankKey(a); const kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

function ago(ms, now) {
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  return mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function postedLabel(ev, now) {
  const j = ev.job;
  if (ev.fresh.status === STATUS.VERIFY) return Number.isFinite(j.listedAt) ? `listed ${ago(j.listedAt, now)} (not confirmed at employer)` : 'date unknown';
  if (j.postedEvidence === EVIDENCE.DAY) return 'today (employer date, no time)';
  return `${ago(ev.fresh.originalAt ?? j.postedAt, now)} (employer)`;
}

// One posting can reach the shortlist twice when two sources describe it with
// different location text (e.g. "New York City" vs "New York City · US
// Remote"), which defeats the company+title+location dedup key. The verified
// apply URL is the posting's identity at the employer, so keep the first
// (best-ranked) row per URL.
export function uniqueByApplyUrl(evs) {
  const seen = new Set();
  return evs.filter((ev) => {
    const url = verifiedApplyUrl(ev.job);
    if (!url) return true;
    // Query strings can carry the job id (embed/job_app?token=…), so only the
    // fragment, tracking params and a trailing slash are ignored.
    const key = url.replace(/#.*$/, '').replace(/([?&])(utm_[a-z]+|gh_src|source|ref)=[^&]*/gi, '$1')
      .replace(/[?&]+$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toRow(ev, now) {
  const j = ev.job;
  const s = ev.elig.salary;
  return {
    status: ev.fresh.status,
    posted: postedLabel(ev, now),
    postedAt: ev.fresh.originalAt ?? j.postedAt ?? null,
    fit: ev.score.fit,
    company: j.company,
    title: j.title,
    location: j.location || '—',
    salary: s && (s.min || s.max) ? (s.max && s.max !== s.min ? `$${s.min}K–$${s.max}K` : `$${s.min || s.max}K`) : '—',
    eligibility: ev.elig.eligibility,
    eligibilityNote: [...ev.elig.blocked, ...ev.elig.verify][0]?.quote?.slice(0, 120) || [...ev.elig.blocked, ...ev.elig.verify][0]?.reason || '',
    why: ev.score.why,
    freshness: ev.fresh.reason,
    // Only ever the verified official employer/ATS URL (final gate guarantees it).
    applyUrl: verifiedApplyUrl(j),
    employerConfirmed: Boolean(verifiedApplyUrl(j)),
    liveVia: j.liveVia || '',
    discoveredOn: [j.source, ...(j.alsoSeenOn || [])].join(', '),
    discoveryUrl: j.url, // reference only (may be LinkedIn/Indeed) — never the apply link
    verifiedVia: j.verifiedVia || '',
    description: j.description || '', // input for the optional AI fit note
  };
}

// ── diagnostics ───────────────────────────────────────────────────────

export const AGE_BUCKETS = ['<6h', '6–12h', '12–24h', '1–3d', '>3d', 'today (day-only)', 'unknown'];

/**
 * Age of every evaluated job, for diagnostics only (the Top 10 rule stays
 * "credible ≤24h"). Uses the best time we have: the employer's date when
 * credible, otherwise the listing time. `employerDated` counts how many in
 * each bucket rest on an employer date rather than a LinkedIn/Indeed time.
 */
export function ageBreakdown(evaluated, now) {
  const out = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { total: 0, employerDated: 0 }]));
  for (const ev of evaluated) {
    const j = ev.job;
    const credible = CREDIBLE_EVIDENCE.has(j.postedEvidence) && Number.isFinite(j.postedAt);
    let bucket;
    if (credible && j.postedEvidence === EVIDENCE.DAY) {
      const h = (now - j.postedAt) / 3_600_000;
      bucket = ev.fresh.fresh ? 'today (day-only)' : h <= 72 ? '1–3d' : '>3d';
    } else {
      const t = credible ? j.postedAt : (Number.isFinite(j.listedAt) ? j.listedAt : null);
      if (t == null) bucket = 'unknown';
      else {
        const h = (now - t) / 3_600_000;
        bucket = h < 6 ? '<6h' : h < 12 ? '6–12h' : h <= 24 ? '12–24h' : h <= 72 ? '1–3d' : '>3d';
      }
    }
    out[bucket].total++;
    if (credible) out[bucket].employerDated++;
  }
  return out;
}

export function summarizeFailures(sources) {
  const list = [];
  for (const [src, s] of Object.entries(sources || {})) for (const f of s?.failures || []) list.push({ source: src, ...f });
  const byReason = {};
  for (const f of list) {
    const k = f.reason === 'http' && f.status ? `http ${f.status}` : f.reason;
    byReason[k] = (byReason[k] || 0) + 1;
  }
  list.sort((a, b) => b.elapsedMs - a.elapsedMs);
  return { total: list.length, byReason, list: list.slice(0, 50) };
}

// ── main ──────────────────────────────────────────────────────────────

export async function runFreshScan(opts = {}) {
  const config = opts.config || loadConfig(opts.overrides || {});
  const filters = opts.filters || config.filters || {};
  const presetFilter = buildPresetFilter(filters);
  const now = opts.now ?? Date.now();
  const clock = createClock({ sourceBudgetMs: config.sourceBudgetMs, softMs: config.softMs, hardMs: config.hardMs });
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const env = opts.env || process.env;
  const counters = { requests: 0 };
  const ledger = new CostLedger({ warnUsd: config.apify.warnUsd, capUsd: config.apify.scanCapUsd, perRunCapUsd: config.apify.perRunCapUsd });
  const timings = {};
  const mark = (name) => { timings[name] = clock.elapsed(); };
  const S = { stage: 'start', evaluated: [], sources: {}, excluded: {}, earlyStop: false, deduper: new Deduper() };
  const bump = (k, n = 1) => { S.excluded[k] = (S.excluded[k] || 0) + n; };

  const work = (async () => {
    const deps = await loadDeps(config, opts);
    S.deps = deps;
    const ctx = {
      now, windowMs: (config.windowHours || 24) * 3_600_000, skills: deps.skills, profile: deps.profile, store: deps.store,
    };
    ctx.presetFilter = presetFilter;
    S.ctx = ctx;
    mark('setup');

    // Early-stop bookkeeping: count strong jobs as they stream in.
    const strong = new Set();
    const prefilter = (job) => {
      if (!deps.titleFilter(job.title)) { bump('title filter'); return false; }
      return true;
    };
    const emit = (jobs) => {
      for (const j of jobs) {
        const merged = S.deduper.add(j);
        const ev = evaluate(merged, ctx);
        if (isStrong(ev, config)) strong.add(merged);
      }
      // Merges can retire previously-strong objects; count only live ones.
      const live = S.deduper.jobs;
      let n = 0; for (const j of strong) if (live.has(j)) n++;
      if (n >= config.topN && !S.earlyStop) { S.earlyStop = true; clock.stopSources(`early stop: ${n} strong jobs`); }
    };
    const strongCount = () => { let n = 0; for (const j of strong) if (S.deduper.jobs.has(j)) n++; return n; };

    // ── Stage 1: sources (≤3 workers) ──
    S.stage = 'sources';
    const sourceFetch = makeFetchJson(clock.sourcesSignal, { timeoutMs: config.requestTimeoutMs, fetchImpl, counters });
    const httpCtx = deps.httpCtx || boundedHttpCtx(clock.sourcesSignal, { timeoutMs: config.requestTimeoutMs, sinceMs: now - DAY * 2 });
    if (config.sources['company-boards'] && deps.workdayIndex === undefined) deps.workdayIndex = await loadWorkdayIndex(config, deps, sourceFetch);
    const runs = deps.sources.slice(0, 3).map(async (src) => {
      const t0 = clock.elapsed();
      try {
        S.sources[src.id] = { running: true };
        const r = await src.run({
          config, portals: deps.portals, providers: deps.providers, env, now, clock, ledger, store: deps.store,
          signal: clock.sourcesSignal, hardSignal: clock.hardSignal, emit, prefilter, strongCount,
          fetchJson: sourceFetch, fetchImpl, httpCtx, rotationLists: deps.rotationLists, deadBoards: deps.deadBoards,
          filters, workdayIndex: deps.workdayIndex,
        });
        S.sources[src.id] = { ...r, ms: clock.elapsed() - t0 };
      } catch (err) {
        S.sources[src.id] = { error: err.message.slice(0, 200), ms: clock.elapsed() - t0 };
      }
    });
    await Promise.race([Promise.all(runs), abortPromise(clock.softSignal).catch(() => {})]);
    clock.stopSources(clock.reasons.sources || 'sources finished');
    mark('sources');

    // ── Stage 2–4: dedup → first-seen → freshness → hard filters → score ──
    S.stage = 'filter';
    S.collected = S.deduper.jobs.size;
    const candidates = filterAndEvaluate(S.deduper.all(), deps, ctx, S.evaluated, bump);
    mark('filter');

    // ── Stage 5: job text, only where needed, top 25 ──
    S.stage = 'jd';
    const enrichFetch = makeFetchJson(clock.softSignal, { timeoutMs: config.requestTimeoutMs, fetchImpl, counters });
    const enrichFetchText = makeFetchText(clock.softSignal, { timeoutMs: config.requestTimeoutMs, fetchImpl, counters });
    const needText = config.enrich === false ? [] : candidates.slice(0, config.jdFetchMax).filter((ev) => !ev.elig.hasText && (employerAtsKind(ev.job.url) || employerAtsKind(ev.job.employerUrl)));
    await pool(needText, config.jdConcurrency, async (ev) => {
      const got = await fetchAtsPosting(employerAtsKind(ev.job.url) ? ev.job.url : ev.job.employerUrl, enrichFetch, enrichFetchText).catch(() => null);
      if (!got) return;
      if (got.description) ev.job.description = got.description;
      applyEmployerFacts(ev.job, got);
      Object.assign(ev, evaluate(ev.job, ctx));
    }, clock.softSignal);
    mark('jd');

    // ── Stage 6: employer verification (canonical posting on the employer's ATS) ──
    // Every candidate in the top 25 that lacks a credible employer date or a
    // live employer page is checked — under the strict rule an unverified job
    // can never be shown, so verification decides what reaches the results.
    S.stage = 'verify';
    const pool25 = candidates.filter((ev) => ev.elig.eligibility !== 'BLOCKED' && freshnessAllowsCandidate(ev.fresh)).sort(byRank);
    const toVerify = config.enrich === false ? [] : pool25.slice(0, config.jdFetchMax)
      .filter((ev) => !CREDIBLE_EVIDENCE.has(ev.job.postedEvidence) || !verifiedApplyUrl(ev.job));
    const boardCache = new Map();
    if (toVerify.length && deps.workdayIndex === undefined) deps.workdayIndex = await loadWorkdayIndex(config, deps, enrichFetch);
    if (toVerify.length && deps.icimsIndex === undefined) deps.icimsIndex = await loadIcimsIndex(config, enrichFetch);
    await pool(toVerify, config.jdConcurrency, async (ev) => {
      let v = await verifyAtEmployer(ev.job, { fetchJson: enrichFetch, fetchText: enrichFetchText, boardCache, trackedBoards: deps.trackedBoards }).catch(() => null);
      // Not confirmed on Greenhouse/Lever/Ashby (or via its own link)? Try the
      // employer's Workday site. Only a full Workday confirmation replaces v.
      if ((!v || v.live !== true) && deps.workdayIndex) {
        const w = await verifyViaWorkday(ev.job, { fetchJson: enrichFetch, index: deps.workdayIndex }).catch(() => ({ facts: null, reason: 'error' }));
        if (w.facts) v = w.facts;
        else ev.job.workdayReason = w.reason;
      }
      // Then Oracle (sites tied to the employer in config) and iCIMS (exact tenant,
      // employer confirmed by the posting). Only a full confirmation replaces v.
      if (!v || v.live !== true) {
        const o = await verifyViaOracle(ev.job, { fetchJson: enrichFetch, companyBoards: config.companyBoards, trackedCompanies: deps.portals?.tracked_companies }).catch(() => ({ facts: null, reason: 'error' }));
        if (o.facts) v = o.facts; else ev.job.oracleReason = o.reason;
      }
      if ((!v || v.live !== true) && deps.icimsIndex) {
        const i = await verifyViaIcims(ev.job, { fetchText: enrichFetchText, index: deps.icimsIndex, trackedCompanies: deps.portals?.tracked_companies }).catch(() => ({ facts: null, reason: 'error' }));
        if (i.facts) v = i.facts; else ev.job.icimsReason = i.reason;
      }
      if (!v) return;
      ev.job.employerUrl = v.employerUrl;
      ev.job.verifiedVia = v.via;
      if ((v.description?.length || 0) > (ev.job.description?.length || 0)) ev.job.description = v.description;
      applyEmployerFacts(ev.job, v);
      // Board listings (e.g. Greenhouse's job list) carry no job text, so a job
      // verified that way would show eligibility VERIFY for "no job text".
      // Read the text from the now-known employer posting.
      if ((ev.job.description?.length || 0) < 200 && employerAtsKind(ev.job.employerUrl)) {
        const got = await fetchAtsPosting(ev.job.employerUrl, enrichFetch, enrichFetchText).catch(() => null);
        if ((got?.description?.length || 0) > (ev.job.description?.length || 0)) ev.job.description = got.description;
      }
      Object.assign(ev, evaluate(ev.job, ctx));
    }, clock.softSignal);
    mark('verify');

    // ── Stage 7: strict final gate → rank → shortlist ≤15 → Top 10 ──
    S.stage = 'rank';
    const pass = candidates.filter((ev) => {
      const why = finalGateReason(ev);
      if (why) { bump(why); return false; }
      return true;
    }).sort(byRank);
    S.shortlist = pass.slice(0, config.shortlistMax);
    mark('rank');
    return deps;
  })();

  let deps = null;
  let hardStopped = false;
  try {
    deps = await Promise.race([work, abortPromise(clock.hardSignal)]);
  } catch (err) {
    if (clock.hardSignal.aborted) hardStopped = true;
    else { clock.dispose(); clock.stopHard('error'); throw err; }
  }
  clock.dispose();
  clock.stopHard(hardStopped ? clock.reasons.hard : 'done'); // cancel any straggler request

  // Hard stop mid-pipeline: rank whatever was collected so far (sync, cheap).
  let shortlist = S.shortlist;
  if (!shortlist) {
    if (!S.evaluated.length && S.deps && S.ctx) {
      S.collected = S.deduper.jobs.size;
      filterAndEvaluate(S.deduper.all(), S.deps, S.ctx, S.evaluated, bump);
    }
    shortlist = S.evaluated.filter((ev) => finalGateReason(ev) === null).sort(byRank).slice(0, config.shortlistMax);
  }
  // Belt and braces: nothing that fails the strict gate is ever returned.
  shortlist = shortlist.filter((ev) => finalGateReason(ev) === null);
  const top = uniqueByApplyUrl(shortlist).slice(0, config.topN).map((ev) => toRow(ev, now));

  // Remember every observed job, so a later refresh/repost can't look new.
  const store = deps?.store || S.deps?.store || opts.deps?.store;
  if (store && opts.persist !== false) {
    for (const j of S.deduper.all()) store.upsert(j, now);
    try { store.save(now); } catch (err) { S.saveError = err.message; }
  }

  const partial = hardStopped || Boolean(clock.reasons.soft && clock.reasons.soft !== 'done');
  const result = {
    generated: new Date(now).toISOString(),
    preset: config.preset || { name: 'run', description: '' },
    filters,
    elapsedMs: clock.elapsed(),
    partial,
    stopReason: hardStopped ? clock.reasons.hard : (clock.reasons.soft !== 'done' ? clock.reasons.soft : null),
    sourcesStopReason: clock.reasons.sources,
    earlyStop: S.earlyStop,
    stageReached: S.stage,
    timingsMs: timings,
    sources: S.sources,
    apify: ledger.summary(),
    requests: counters.requests,
    counts: {
      collected: S.collected ?? S.deduper.jobs.size,
      evaluated: S.evaluated.length,
      shortlisted: shortlist.length,
      top: top.length,
      new: top.filter((r) => r.status === STATUS.NEW).length,
      eligibilityVerify: top.filter((r) => r.eligibility === 'VERIFY').length,
      verifiedAtEmployer: S.evaluated.filter((ev) => ev.job.verifiedVia && ev.job.liveVerified).length,
      // Freshness of every evaluated job (after title/location/blacklist/tracker filters).
      byFreshness: S.evaluated.reduce((m, ev) => { const k = ev.fresh.status === STATUS.SEEN && ev.fresh.fresh ? 'SEEN_FRESH' : ev.fresh.status; m[k] = (m[k] || 0) + 1; return m; }, {}),
      within24hCredible: S.evaluated.filter((ev) => ev.fresh.freshSignal === 'credible' && ev.fresh.fresh).length,
      ageBreakdown: ageBreakdown(S.evaluated, now),
      excluded: S.excluded,
    },
    failures: summarizeFailures(S.sources),
    top,
  };
  if (opts.write !== false) writeOutputs(result, config);
  return result;
}

export function writeOutputs(result, config) {
  const stamp = result.generated.replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(config.paths.outDir, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(result, null, 1);
  fs.writeFileSync(path.join(dir, 'fresh.json'), json);
  fs.writeFileSync(path.join(dir, 'fresh.md'), renderMarkdown(result));
  fs.writeFileSync(path.join(config.paths.outDir, 'latest.json'), json);
  result.outDir = dir;
  return dir;
}
