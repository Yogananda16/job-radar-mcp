// tools.mjs — the operations job-radar exposes to other programs (the MCP
// server today; a dashboard later). Each returns plain JSON-friendly data.
import { runFreshScan } from './engine/run.mjs';
import { loadConfigForPreset } from './engine/config.mjs';
import { checkEligibility } from './engine/eligibility.mjs';
import { scoreJob, compileSkills, loadCvSkillsFile } from './engine/score.mjs';
import { employerAtsKind, fetchAtsPosting } from './engine/ats.mjs';
import { makeFetchJson, makeFetchText } from './engine/runtime.mjs';
import os from 'os';
import path from 'path';

const HOUR = 3_600_000;

/**
 * Run one scan. Free sources only unless includeApify is true AND the caller
 * allows paid scans (allowPaid). dryRun keeps state untouched.
 */
export async function runScanTool({ preset = 'run', includeApify = false, dryRun = true, allowPaid = false } = {}) {
  const apify = includeApify && allowPaid;
  const overrides = apify ? {} : { sources: { apify: false } };
  if (dryRun) Object.assign(overrides, { stateFile: path.join(os.tmpdir(), `job-radar-state-${process.pid}.json`), recordDeadBoards: false });
  const config = loadConfigForPreset(preset, overrides);
  const r = await runFreshScan({ config, persist: !dryRun, write: false });
  return {
    preset: r.preset?.name || preset,
    generated: r.generated,
    runtimeSeconds: Math.round(r.elapsedMs / 1000),
    apifyUsd: Number(r.apify?.spentUsd || 0),
    apifyUsed: apify,
    note: includeApify && !allowPaid ? 'Apify was requested but paid scans are disabled for this server (set RADAR_MCP_ALLOW_APIFY=1 to allow).' : undefined,
    jobs: r.top.map(({ description, discoveryUrl, ...row }) => row),
    excluded: r.counts?.excluded || {},
  };
}

/** Eligibility + fit for a piece of job text, using the configured profile. */
export function checkEligibilityTool({ title = '', description = '' } = {}, config = loadConfigForPreset('run')) {
  const job = { title, description, location: '', salary: null };
  const elig = checkEligibility(job, config.profile);
  const skills = compileSkills(config.profile.skills || loadCvSkillsFile(config.paths.cv));
  const score = scoreJob(job, elig, skills, config.profile);
  return {
    eligibility: elig.eligibility,
    blocked: elig.blocked,
    verify: elig.verify,
    yearsAsked: elig.yearsMin,
    salaryK: elig.salary,
    fit: score.fit,
    why: score.why,
    matchedSkills: score.skillHits,
  };
}

/**
 * Is a posting live at the employer, and how old is it? Works for posting
 * URLs on Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle and
 * iCIMS. LinkedIn/Indeed links are rejected: they are discovery only.
 */
export async function checkJobLinkTool({ url, title = '' } = {}, { fetchImpl = globalThis.fetch, now = Date.now(), config } = {}) {
  const kind = employerAtsKind(url);
  if (!kind) {
    return { supported: false, url, reason: 'Not a posting URL on a supported employer ATS. LinkedIn/Indeed and similar boards are discovery only: find the same job on the employer careers page.' };
  }
  const signal = AbortSignal.timeout(20_000);
  const got = await fetchAtsPosting(url, makeFetchJson(signal, { fetchImpl }), makeFetchText(signal, { fetchImpl }));
  if (!got) return { supported: true, ats: kind, url, live: false, reason: 'The ATS did not return this posting (closed, removed, or unreachable).' };
  const ageHours = Number.isFinite(got.postedAt) ? Math.round(((now - got.postedAt) / HOUR) * 10) / 10 : null;
  const elig = checkEligibilityTool({ title, description: got.description || '' }, config || loadConfigForPreset('run'));
  return {
    supported: true,
    ats: kind,
    url,
    applyUrl: got.employerUrl || url,
    live: got.closed ? false : got.live !== false,
    postedAt: Number.isFinite(got.postedAt) ? new Date(got.postedAt).toISOString() : null,
    ageHours,
    postedWithin24h: ageHours != null ? ageHours <= 24 : null,
    requisitionId: got.requisitionId || null,
    ...elig,
  };
}
