// sources/tracked.mjs — W1: every enabled tracked company in portals.yml that a
// zero-key provider module can read (Greenhouse, Lever, Ashby, Workday,
// SmartRecruiters, …). Run in-process (not by spawning scan.mjs) so the scan can
// stop at any moment and keep what each finished board returned.
// Skipped: websearch-only entries, local parsers (they exec commands), keyed plugins.
import { resolveProvider } from '../../vendor/providers/_registry.mjs';
import { runBoards } from '../boards.mjs';

// `category` (optional): only entries tagged with it in portals.yml, e.g.
// `category: startup` (or `categories: [startup, ai]`) for the startup preset.
export function trackedBoards(portals, providers, { category = null } = {}) {
  const out = [];
  const skipped = [];
  for (const entry of portals.tracked_companies || []) {
    if (!entry || entry.enabled === false) continue;
    if (category) {
      const tags = [entry.category, ...(Array.isArray(entry.categories) ? entry.categories : [])].filter(Boolean).map((t) => String(t).toLowerCase());
      if (!tags.includes(String(category).toLowerCase())) continue;
    }
    if (entry.scan_method === 'websearch' || !entry.careers_url) { skipped.push(entry.name); continue; }
    const r = resolveProvider(entry, providers, { skipIds: ['local-parser'] });
    if (!r?.provider) { skipped.push(entry.name); continue; }
    out.push({ entry, provider: r.provider, key: `tracked:${entry.name}` });
  }
  return { boards: out, skipped };
}

// Public job boards (config.publicBoards) as discovery-only aggregator boards.
export function publicBoardEntries(list, providers) {
  const out = [];
  const skipped = [];
  for (const entry of list || []) {
    const p = entry?.provider && providers?.get(entry.provider);
    if (!p) { skipped.push(entry?.name || '?'); continue; }
    out.push({ entry, provider: p, key: `board:${entry.name}`, aggregator: true });
  }
  return { boards: out, skipped };
}

export default {
  id: 'tracked',
  async run(ctx) {
    const tracked = trackedBoards(ctx.portals, ctx.providers, { category: ctx.config.trackedCategory });
    // Public boards ride in this same worker (≤3 workers overall); not for
    // category-scoped presets such as `startup`.
    const pub = ctx.config.includePublicBoards && !ctx.config.trackedCategory
      ? publicBoardEntries(ctx.config.publicBoards, ctx.providers) : { boards: [], skipped: [] };
    const boards = [...tracked.boards, ...pub.boards];
    const skipped = [...tracked.skipped, ...pub.skipped];
    const res = await runBoards(boards, {
      signal: ctx.signal,
      emit: ctx.emit,
      source: 'tracked',
      prefilter: ctx.prefilter,
      concurrency: ctx.config.boardConcurrency,
      perBoardMs: ctx.config.perBoardMs,
      httpCtx: ctx.httpCtx,
    });
    return { boards: boards.length, publicBoards: pub.boards.length, skippedNoApi: skipped.length, ...res, done: res.done.length, failed: res.failed.length, unfinished: res.unfinished.length, failures: res.failures };
  },
};
