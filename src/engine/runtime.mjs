// runtime.mjs — deadlines, bounded fetch, worker pool and the Apify cost ledger.
//
// Three signals drive every scan:
//   sourcesStop  sources stop starting new work (source budget hit, 3-min soft
//                deadline, or early stop)
//   soft         3 min: no new work anywhere — finish with what we have
//   hard         5 min: abort everything; the caller returns partial results
// Every network call takes one of these signals, so nothing outlives the scan.

export function createClock({ sourceBudgetMs, softMs, hardMs, now = () => Date.now() }) {
  const start = now();
  const soft = new AbortController();
  const hard = new AbortController();
  const sourcesStop = new AbortController();
  const timers = [];
  const reasons = { sources: null, soft: null, hard: null };

  const stopSources = (why) => { if (!sourcesStop.signal.aborted) { reasons.sources = why; sourcesStop.abort(why); } };
  const stopSoft = (why) => { stopSources(why); if (!soft.signal.aborted) { reasons.soft = why; soft.abort(why); } };
  const stopHard = (why) => { stopSoft(why); if (!hard.signal.aborted) { reasons.hard = why; hard.abort(why); } };

  timers.push(setTimeout(() => stopSources('source budget reached'), sourceBudgetMs));
  timers.push(setTimeout(() => stopSoft('3-minute soft deadline'), softMs));
  timers.push(setTimeout(() => stopHard('5-minute hard deadline'), hardMs));

  return {
    start,
    elapsed: () => now() - start,
    sourcesSignal: sourcesStop.signal,
    softSignal: soft.signal,
    hardSignal: hard.signal,
    reasons,
    stopSources,
    stopSoft,
    stopHard,
    dispose: () => timers.forEach(clearTimeout),
  };
}

// A promise that rejects when the signal aborts — for racing work that cannot
// itself take a signal (provider modules).
export function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error(String(signal.reason || 'aborted')));
    signal.addEventListener('abort', () => reject(new Error(String(signal.reason || 'aborted'))), { once: true });
  });
}

export function raceSignal(promise, signal) {
  return Promise.race([promise, abortPromise(signal)]);
}

// A timeout signal backed by a normal (ref'd) timer. AbortSignal.timeout()
// uses an unref'd timer, so when the only pending work is a provider promise
// that never settles, Node (e.g. 22.x) can let the event loop empty and exit
// before the timeout ever fires. Call clear() when the work finishes.
export function refTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * JSON GET/POST bounded by a per-request timeout AND the scan's signal.
 * Returns null on any failure (a dead board must not fail the scan).
 */
export function makeFetchJson(signal, { timeoutMs = 8000, fetchImpl = globalThis.fetch, counters = null } = {}) {
  return async (url, opts = {}) => {
    if (signal.aborted) return null;
    if (counters) counters.requests = (counters.requests || 0) + 1;
    try {
      const res = await fetchImpl(url, {
        ...opts,
        headers: { 'user-agent': 'job-radar (+https://github.com/Yogananda16/job-radar)', accept: 'application/json', ...(opts.headers || {}) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(opts.timeoutMs || timeoutMs, timeoutMs))]),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
}

// Same bounds as makeFetchJson, for HTML pages (iCIMS postings). Sends a
// browser-like UA, as providers/icims.mjs does (iCIMS WAFs reject unknown UAs).
// Returns the body text, or null on any failure.
export function makeFetchText(signal, { timeoutMs = 8000, fetchImpl = globalThis.fetch, counters = null, userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } = {}) {
  return async (url) => {
    if (signal.aborted) return null;
    if (counters) counters.requests = (counters.requests || 0) + 1;
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': userAgent, 'accept-language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };
}

// Run fn over items with bounded concurrency; stops taking new items once the
// signal aborts. Never throws.
export async function pool(items, concurrency, fn, signal) {
  let i = 0;
  const results = [];
  const worker = async () => {
    while (i < items.length && !signal?.aborted) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); } catch (err) { results[idx] = { error: err }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

/**
 * Apify spend ledger. Every actor run must reserve its server-enforced
 * maxTotalChargeUsd BEFORE it starts, so the sum of reservations can never
 * exceed the per-scan cap — even if every run spends its full cap.
 */
export class CostLedger {
  constructor({ warnUsd = 0.25, capUsd = 0.25, perRunCapUsd = 0.05 } = {}) {
    this.warnUsd = warnUsd;
    this.capUsd = capUsd;
    this.perRunCapUsd = perRunCapUsd;
    this.reserved = 0;
    this.spent = 0;
    this.runs = [];
  }
  // Returns the per-run cap granted, or 0 when the scan cap would be exceeded.
  reserve(label) {
    const remaining = Math.round((this.capUsd - this.reserved) * 1e4) / 1e4;
    const grant = Math.min(this.perRunCapUsd, remaining);
    if (grant < 0.005) return 0;
    this.reserved += grant;
    this.runs.push({ label, grant, cost: null });
    return grant;
  }
  record(label, costUsd) {
    const run = [...this.runs].reverse().find((r) => r.label === label && r.cost == null);
    if (run) {
      run.cost = costUsd;
      // Release the unused part of the reservation.
      this.reserved -= Math.max(0, run.grant - costUsd);
    }
    this.spent += costUsd;
  }
  summary() {
    return {
      spentUsd: Math.round(this.spent * 1e4) / 1e4,
      capUsd: this.capUsd,
      warn: this.spent >= this.warnUsd,
      runs: this.runs,
    };
  }
}
