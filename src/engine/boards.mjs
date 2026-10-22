// boards.mjs — run the vendored ATS provider modules over a list of board entries,
// in-process, with per-board timeouts and a stop signal. Results stream out per
// board (ctx.emit), so a stop at the source budget / 3-min mark keeps
// everything fetched so far.
import { makeHttpCtx } from '../vendor/providers/_http.mjs';
import { makeJob, EVIDENCE } from './job.mjs';
import { employerAtsKind } from './ats.mjs';
import { raceSignal, pool, refTimeout } from './runtime.mjs';

// Providers whose postedAt is the employer's own first-publish timestamp.
const EXACT_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);

export function providerJobToJob(j, { providerId, entryName, source, aggregator = false }) {
  const postedAt = typeof j.postedAt === 'number' && j.postedAt > 0 ? j.postedAt : null;
  if (aggregator) {
    // Public job boards (RemoteOK, Built In, …) are DISCOVERY ONLY, like
    // LinkedIn/Indeed: the board's date is a listing time, the board page is
    // not the employer's page, and nothing is "live at the employer" until
    // employer verification confirms it. The posting URL counts as an
    // employer link only when it is itself an employer ATS posting.
    const url = String(j.url || '');
    return makeJob({
      source: `board:${providerId}`,
      sourceJobId: j.id || '',
      url,
      employerUrl: employerAtsKind(url) ? url : '',
      company: j.company && j.company !== entryName ? j.company : '', // a board's own name is not an employer
      title: j.title,
      location: j.location,
      postedAt,
      postedEvidence: postedAt ? EVIDENCE.AGGREGATOR : EVIDENCE.NONE,
      description: j.description || '',
      salary: j.salary && (j.salary.min || j.salary.max) ? { min: j.salary.min, max: j.salary.max, unit: j.salary.unit || j.salary.period || 'year', text: '' } : null,
      liveVerified: false,
    });
  }
  return makeJob({
    source,
    sourceJobId: j.id || '',
    requisitionId: j.requisitionId || '',
    url: j.url,
    company: j.company || entryName,
    title: j.title,
    location: j.location,
    postedAt,
    // A non-ATS provider's date is trusted only at day precision (it must be today).
    postedEvidence: postedAt ? (EXACT_PROVIDERS.has(providerId) ? EVIDENCE.ATS : EVIDENCE.DAY) : EVIDENCE.NONE,
    description: j.description || '',
    salary: j.salary && (j.salary.min || j.salary.max) ? { min: j.salary.min, max: j.salary.max, unit: j.salary.unit || j.salary.period || 'year', text: '' } : null,
    // The employer's live board listed it in this scan → the posting is open.
    liveVerified: true,
    liveVia: `${providerId} board listing`,
  });
}

// An http ctx whose every request is capped at timeoutMs (providers have their
// own longer defaults) and refused once the signal has fired.
export function boundedHttpCtx(signal, { timeoutMs = 8000, sinceMs = null, base = makeHttpCtx() } = {}) {
  const ctx = { ...base, syntheticEntries: true };
  if (sinceMs) ctx.sinceMs = sinceMs;
  for (const m of ['fetchJson', 'fetchText', 'fetchResponse']) {
    const orig = base[m];
    if (typeof orig !== 'function') continue;
    ctx[m] = (url, opts = {}) => {
      if (signal.aborted) return Promise.reject(new Error('stopped'));
      return raceSignal(orig(url, { ...opts, timeoutMs: Math.min(opts.timeoutMs || timeoutMs, timeoutMs) }), signal);
    };
  }
  return ctx;
}

const NETWORK_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_\w+|CERT_\w+|ERR_TLS\w*|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/;

/**
 * Why a board failed, in one of five buckets:
 *   http     the board answered with a non-2xx status (status kept)
 *   timeout  the per-board limit or a per-request 8s limit fired
 *   network  DNS / connection / TLS failure
 *   stopped  cut off by the scan's stop signal (reported as unfinished, not failed)
 *   error    anything else (bad JSON, provider error, …)
 */
export function classifyFailure(err, { boardTimedOut = false, stopped = false } = {}) {
  const status = Number.isInteger(err?.status) ? err.status : null;
  const msg = String(err?.message || err || '');
  const code = err?.cause?.code || err?.code || '';
  let reason = 'error';
  if (stopped) reason = 'stopped';
  else if (status) reason = 'http';
  else if (boardTimedOut || /TimeoutError|timed? ?out|operation was aborted|AbortError/i.test(`${err?.name || ''} ${msg}`)) reason = 'timeout';
  else if (NETWORK_CODES.test(code) || /fetch failed|getaddrinfo|socket hang up|network/i.test(msg)) reason = 'network';
  return { reason, status, code: code || null, message: msg.replace(/\s+/g, ' ').slice(0, 160) };
}

/**
 * @param {Array<{entry: object, provider: object}>} boards
 * @param {object} o
 * @returns {Promise<{done: string[], failed: string[], unfinished: string[], jobs: number}>}
 */
export async function runBoards(boards, o) {
  const { signal, emit, source, prefilter = () => true, concurrency = 6, perBoardMs = 20000, httpCtx } = o;
  const done = []; const failed = []; const failures = []; const started = new Set();
  let jobs = 0;
  await pool(boards, concurrency, async ({ entry, provider, key, aggregator }) => {
    started.add(key);
    const t0 = Date.now();
    const timeout = refTimeout(perBoardMs);
    const boardTimer = timeout.signal;
    try {
      const raw = await raceSignal(provider.fetch(entry, httpCtx), AbortSignal.any([signal, boardTimer]));
      const mapped = (Array.isArray(raw) ? raw : [])
        .filter((j) => j && j.title && j.url)
        .map((j) => providerJobToJob(j, { providerId: provider.id, entryName: entry.name, source, aggregator: Boolean(aggregator) }))
        .filter(prefilter);
      jobs += mapped.length;
      if (mapped.length) emit(mapped);
      done.push(key);
    } catch (err) {
      // Cut off by the stop signal → unfinished (retried next rotation), not failed.
      if (signal.aborted && !boardTimer.aborted) return;
      failed.push(key);
      failures.push({
        board: key,
        company: entry.name || '',
        url: entry.careers_url || '',
        provider: provider.id || 'unknown',
        ...classifyFailure(err, { boardTimedOut: boardTimer.aborted }),
        elapsedMs: Date.now() - t0,
      });
    } finally {
      timeout.clear();
    }
  }, signal);
  const unfinished = boards.map((b) => b.key).filter((k) => !done.includes(k) && !failed.includes(k));
  return { done, failed, failures, unfinished, jobs, started: started.size };
}
