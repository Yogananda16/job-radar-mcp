// apify-client.mjs — minimal Apify API client for discovery.
//
// Same transport pattern as plugins/apify/_apify.mjs (start → poll → dataset,
// token in the Authorization header, never in a URL), plus what discovery needs
// that the plugin helper does not expose:
//   • maxTotalChargeUsd on every run — Apify enforces the spend cap server-side
//   • timeout (seconds) on every run — Apify stops the actor itself
//   • a stop signal: on stop we ABORT the run and keep the items already pushed
//   • a cost read-back for the ledger
const API = 'https://api.apify.com/v2';
const ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*[~/][A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export function actorPath(actorId) {
  if (!ACTOR_ID_RE.test(String(actorId))) throw new Error(`invalid Apify actor id ${JSON.stringify(actorId)}`);
  const [owner, name] = actorId.split(/[~/]/, 2);
  return `${encodeURIComponent(owner)}~${encodeURIComponent(name)}`;
}

export const APIFY_TOKEN_HELP =
  'APIFY_TOKEN is not set. Get it at https://console.apify.com → Settings → API & Integrations → "Personal API tokens", ' +
  'then add one line `APIFY_TOKEN=<your token>` to the .env file in the project root (git-ignored), or add it as a GitHub Actions secret. Never put it in source code.';

/**
 * Exact charge of a finished pay-per-event run: Σ chargedEventCounts[e] × price(e).
 * Shape observed on the 2026-10-11 probe:
 *   chargedEventCounts: { 'apify-default-dataset-item': 5, 'apify-actor-start': 1 }
 *   pricingInfo.pricingPerEvent.actorChargeEvents[e].eventPriceUsd
 * Returns null when either part is missing (caller falls back to an estimate).
 */
export function chargedUsd(run) {
  const counts = run?.chargedEventCounts;
  const events = run?.pricingInfo?.pricingPerEvent?.actorChargeEvents;
  if (!counts || !events || typeof counts !== 'object') return null;
  let total = 0;
  for (const [ev, n] of Object.entries(counts)) {
    const price = Number(events[ev]?.eventPriceUsd);
    if (!Number.isFinite(price) || !Number.isFinite(Number(n))) return null;
    total += price * Number(n);
  }
  return Math.round(total * 1e6) / 1e6;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Run one actor with hard limits.
 * @param {object} p
 * @param {string} p.actorId
 * @param {object} p.input
 * @param {string} p.token
 * @param {number} p.maxChargeUsd   server-enforced spend cap for this run
 * @param {number} p.timeoutSec     server-side actor timeout
 * @param {number} p.maxItems       dataset items to read back
 * @param {AbortSignal} p.stopSignal stop: abort the run, keep pushed items
 * @param {AbortSignal} p.hardSignal hard: abort, no further reads
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<{items: object[], status: string, runId: string|null, usageUsd: number|null, aborted: boolean}>}
 */
export async function runActorBounded(p) {
  const { actorId, input, token, maxChargeUsd, timeoutSec, maxItems, stopSignal, hardSignal } = p;
  const fetchImpl = p.fetchImpl || globalThis.fetch;
  const pollMs = p.pollMs ?? 3000;
  if (!token) throw new Error(APIFY_TOKEN_HELP);
  const auth = { authorization: `Bearer ${token}` };

  const call = async (url, init = {}, ms = 15000) => {
    const res = await fetchImpl(url, { ...init, headers: { ...auth, ...(init.headers || {}) }, signal: AbortSignal.any([hardSignal, AbortSignal.timeout(ms)]) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Apify HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  if (stopSignal.aborted) return { items: [], status: 'NOT_STARTED', runId: null, usageUsd: 0, aborted: true };

  const qs = new URLSearchParams({
    timeout: String(Math.max(10, Math.floor(timeoutSec))),
    maxTotalChargeUsd: String(maxChargeUsd),
    maxItems: String(maxItems),
  });
  const started = await call(`${API}/acts/${actorPath(actorId)}/runs?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input || {}),
  });
  let run = started?.data;
  if (!run?.id) throw new Error('Apify did not return a run id');

  let aborted = false;
  while (!TERMINAL.has(run.status)) {
    if (stopSignal.aborted || hardSignal.aborted) {
      aborted = true;
      try { await call(`${API}/actor-runs/${run.id}/abort`, { method: 'POST' }, 5000); } catch { /* best effort */ }
      break;
    }
    await sleep(pollMs, stopSignal);
    if (stopSignal.aborted || hardSignal.aborted) continue;
    try { run = (await call(`${API}/actor-runs/${run.id}`))?.data || run; } catch (err) { if (err.status >= 400 && err.status < 500) throw err; }
  }

  let items = [];
  if (!hardSignal.aborted && run.defaultDatasetId) {
    try {
      const got = await call(`${API}/datasets/${run.defaultDatasetId}/items?clean=true&limit=${maxItems}`, {}, 20000);
      if (Array.isArray(got)) items = got;
    } catch { /* keep [] */ }
  }
  // Cost read-back. Per-result charges lag the terminal status (first real
  // scan, 2026-10-11: every run read back only its $0.001 start fee). Re-read
  // while Apify has charged fewer dataset items than we received. Whatever is
  // read, the caller never books less than its own items × price estimate.
  let usageUsd = null;
  let charged = null;
  let chargedItems = null;
  for (let attempt = 0; attempt < 3 && !hardSignal.aborted; attempt++) {
    if (attempt > 0) await sleep(p.costRetryMs ?? 1500, hardSignal);
    try {
      const fin = (await call(`${API}/actor-runs/${run.id}`, {}, 8000))?.data;
      if (fin) {
        run = fin;
        charged = chargedUsd(fin);
        chargedItems = Number(fin.chargedEventCounts?.['apify-default-dataset-item'] ?? NaN);
        usageUsd = Number.isFinite(fin.usageTotalUsd) ? fin.usageTotalUsd : usageUsd;
      }
    } catch { /* unknown */ }
    if (charged != null && Number.isFinite(chargedItems) && chargedItems >= items.length) break;
  }
  const complete = charged != null && Number.isFinite(chargedItems) && chargedItems >= items.length;
  return { items, status: run.status, runId: run.id, usageUsd, chargedUsd: charged, chargeComplete: complete, aborted };
}
