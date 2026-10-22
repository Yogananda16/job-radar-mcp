// Test helpers: temp dirs, a config with tiny deadlines, a fake fetch that
// refuses any host it was not told about (so no test can reach the network).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/engine/config.mjs';
import { SeenStore } from '../src/engine/seen-store.mjs';
import { compileSkills } from '../src/engine/score.mjs';
import { makeJob, EVIDENCE } from '../src/engine/job.mjs';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const NOW = Date.parse('2026-10-11T15:00:00Z');

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-scan-test-'));
}

export function testConfig(dir, patch = {}) {
  const c = loadConfig({}, { root: dir });
  c.paths.outDir = path.join(dir, 'out');
  c.stateFile = path.join(dir, 'state.json');
  c.seenFile = path.join(dir, 'seen.json');
  c.sourceBudgetMs = 2000; c.softMs = 3000; c.hardMs = 5000; // tests run in ms, not minutes
  return Object.assign(c, patch);
}

export const SKILLS = compileSkills(['Python', 'SQL', 'PyTorch', 'LLMs', 'RAG', 'LangChain', 'AWS', 'Docker', 'Machine Learning', 'FastAPI', 'Pandas']);

export const GOOD_JD = 'We are hiring an engineer to build LLMs and RAG systems with Python, SQL, PyTorch, LangChain, FastAPI, Pandas, Docker and AWS. '
  + 'You will design machine learning pipelines, evaluate models, and ship to production. Requirements: 2+ years of experience in machine learning. '
  + 'Visa sponsorship is available for the right candidate. Hybrid in New York, NY. Salary $120,000 - $150,000. '.repeat(1);

export function atsJob(i, patch = {}) {
  return makeJob({
    source: 'tracked',
    sourceJobId: `gh-${i}`,
    url: `https://job-boards.greenhouse.io/acme${i}/jobs/${1000 + i}`,
    company: `Acme ${i}`,
    title: 'Machine Learning Engineer',
    location: 'New York, NY',
    postedAt: NOW - 2 * HOUR,
    postedEvidence: EVIDENCE.ATS,
    description: GOOD_JD,
    liveVerified: true, // as if the employer's board listed it during this scan
    liveVia: 'greenhouse board listing',
    ...patch,
  });
}

export function deps(store, sources, extra = {}) {
  return {
    portals: { tracked_companies: [] },
    titleFilter: (t) => /engineer|scien|analyst/i.test(t),
    locationFilter: () => true,
    blacklist: new Map(),
    findBlacklistEntry: () => null,
    trackerKeys: new Set(),
    skills: SKILLS,
    store,
    sources,
    providers: new Map(),
    trackedBoards: new Map(),
    workdayIndex: null, // no Workday tenant list unless a test supplies one (never downloads)
    icimsIndex: null,   // same for the iCIMS tenant list
    httpCtx: {},
    ...extra,
  };
}

export function freshStore(dir) {
  return new SeenStore({ file: path.join(dir, 'seen.json') });
}

// fetch mock: routes = [[RegExp, (url, init) => body | Response-ish]]
export function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    const u = String(url);
    log.push({ url: u, init });
    if (init.signal?.aborted) throw new Error('aborted');
    for (const [re, handler] of routes) {
      if (re.test(u)) {
        const body = await handler(u, init);
        if (body && body.__status) return { ok: false, status: body.__status, json: async () => ({}), text: async () => 'err' };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error(`unexpected network call in test: ${u}`);
  };
}
