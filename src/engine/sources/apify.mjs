// sources/apify.mjs — W3: LinkedIn + Indeed discovery through Apify, as ONE
// worker. Queries run in waves (primary roles first); the next wave starts only
// if the scan still lacks a strong Top 10 and time remains. Every actor run
// reserves its server-enforced spend cap from the ledger first, so a scan can
// never spend more than the configured cap.
import { runActorBounded, APIFY_TOKEN_HELP } from '../apify-client.mjs';
import { pool } from '../runtime.mjs';
import { linkedinAdapter } from './apify-linkedin.mjs';
import { indeedAdapter } from './apify-indeed.mjs';

export const ADAPTERS = { linkedin: linkedinAdapter, indeed: indeedAdapter };
const DAY = 86_400_000;

// What one run cost — the LARGEST of what we know, never less:
//   • Apify's charged events × prices (exact, but can lag — see apify-client)
//   • Apify's usageTotalUsd
//   • our own floor: items received × configured price + start fee
// Nothing readable after a hard stop → the whole grant. Never above the grant
// (Apify stops the run at maxTotalChargeUsd). Undercounting here would free
// ledger budget that was really spent, so the floor is mandatory.
export function runCost({ chargedUsd = null, usageUsd = null, chargeComplete = false, items, pricePerItemUsd, startUsd, grant, readFailed }) {
  // Apify has charged at least every item we received → its figure is exact.
  if (chargeComplete && Number.isFinite(chargedUsd)) return Math.min(grant, chargedUsd);
  if (readFailed && !Number.isFinite(chargedUsd) && !Number.isFinite(usageUsd)) return grant;
  const floor = items * pricePerItemUsd + startUsd;
  return Math.min(grant, Math.max(Number.isFinite(chargedUsd) ? chargedUsd : 0, Number.isFinite(usageUsd) ? usageUsd : 0, floor));
}

export default {
  id: 'apify',
  async run(ctx) {
    const cfg = ctx.config.apify;
    if (!cfg.enabled) return { skipped: 'disabled in config' };
    const token = ctx.env.APIFY_TOKEN;
    if (!token) return { skipped: 'APIFY_TOKEN missing', help: APIFY_TOKEN_HELP };

    const actors = Object.entries(cfg.actors).filter(([, a]) => a.enabled !== false);
    const stats = { runs: [], items: 0, waves: 0, stoppedBecause: null };
    for (const [waveName, queries] of Object.entries(cfg.queries)) {
      if (ctx.signal.aborted) { stats.stoppedBecause = String(ctx.signal.reason); break; }
      if (stats.waves > 0) {
        if (ctx.strongCount() >= ctx.config.topN) { stats.stoppedBecause = 'early stop: strong Top 10 reached'; break; }
        if (ctx.clock.elapsed() > cfg.nextWaveBeforeMs) { stats.stoppedBecause = 'no time for another wave'; break; }
      }
      stats.waves++;
      const tasks = [];
      for (const q of queries) for (const [name, a] of actors) tasks.push({ q, name, a, adapter: ADAPTERS[name] });

      await pool(tasks, cfg.maxConcurrentRuns, async ({ q, name, a, adapter }) => {
        const label = `${name}:${waveName}:${q}`;
        const grant = ctx.ledger.reserve(label);
        if (!grant) { stats.runs.push({ label, skipped: 'scan spend cap reached' }); return; }
        const skipIds = name === 'linkedin' ? ctx.store.knownSourceIds('apify-linkedin', { sinceMs: ctx.now - 7 * DAY, max: 200 }) : [];
        const companyNames = name === 'linkedin' && Array.isArray(cfg.companyNames) ? cfg.companyNames : [];
        const input = adapter.buildInput(q, { limit: a.limitPerQuery, skipIds, companyNames, ...(a.input || {}) });
        let res; let readFailed = false;
        try {
          res = await runActorBounded({
            actorId: a.actor, input, token,
            maxChargeUsd: grant,
            timeoutSec: Math.max(30, Math.floor((cfg.runTimeoutMs) / 1000)),
            maxItems: a.limitPerQuery,
            stopSignal: ctx.signal,
            hardSignal: ctx.hardSignal,
            fetchImpl: ctx.fetchImpl,
            pollMs: cfg.pollMs,
            costRetryMs: cfg.costRetryMs,
          });
        } catch (err) {
          readFailed = !/HTTP 4\d\d/.test(err.message); // a refused start (4xx) cost nothing
          const cost = readFailed ? grant : 0;
          ctx.ledger.record(label, cost);
          stats.runs.push({ label, error: err.message.slice(0, 160), costUsd: cost });
          return;
        }
        if (ctx.hardSignal.aborted) readFailed = res.chargedUsd == null && res.usageUsd == null && res.runId != null;
        const cost = runCost({ chargedUsd: res.chargedUsd, usageUsd: res.usageUsd, chargeComplete: res.chargeComplete, items: res.items.length, pricePerItemUsd: a.pricePerItemUsd, startUsd: a.startUsd, grant, readFailed });
        const costSource = res.chargeComplete ? 'apify-charged'
          : readFailed && !Number.isFinite(res.chargedUsd) ? 'grant' : 'floor-estimate';
        ctx.ledger.record(label, cost);
        const jobs = res.items
          .filter((it) => it && !it.error)
          .map((it) => adapter.mapItem(it, ctx.now))
          .filter((j) => j.title && j.url)
          .filter(ctx.prefilter);
        stats.items += res.items.length;
        stats.runs.push({ label, status: res.status, aborted: res.aborted, items: res.items.length, kept: jobs.length, costUsd: Math.round(cost * 1e6) / 1e6, costSource });
        // Field names (not values) of the first item, to confirm the adapter mapping.
        if (res.items[0] && !stats.sampleFields?.[name]) stats.sampleFields = { ...(stats.sampleFields || {}), [name]: Object.keys(res.items[0]).sort() };
        if (cfg.captureRaw) stats.raw = { ...(stats.raw || {}), [name]: [...(stats.raw?.[name] || []), ...res.items] };
        if (jobs.length) ctx.emit(jobs);
      }, ctx.signal);
    }
    return stats;
  },
};
