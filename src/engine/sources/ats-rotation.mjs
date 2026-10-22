// sources/ats-rotation.mjs — W2: a capped, rotating batch of public
// Greenhouse/Lever/Ashby boards (default 25 per scan) from the same public
// directory (src/vendor/ats-datasets.mjs). The cursor persists in
// state/discovery-state.json, so repeated scans walk the whole directory over
// time without any single long sweep. Boards a scan could not finish are
// retried first next time.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { SOURCES } from '../../vendor/ats-datasets.mjs';
import { loadDeadBoards, shouldSkipDeadBoard, recordBoardResult, saveDeadBoards } from '../../vendor/dead-boards.mjs';
import { runBoards } from '../boards.mjs';
import { boardFromCareersUrl } from '../ats.mjs';

const ATS = ['greenhouse', 'lever', 'ashby'];
const CACHE_TTL_MS = 24 * 3_600_000;

async function loadList(name, cacheDir, fetchJson) {
  const file = path.join(cacheDir, `${name}.json`);
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS) {
    const l = read(); if (Array.isArray(l)) return l;
  }
  const fresh = await fetchJson(SOURCES[name].dataset, { timeoutMs: 15000 });
  if (Array.isArray(fresh)) {
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(fresh)); } catch { /* cache is optional */ }
    return fresh;
  }
  const stale = read();
  return Array.isArray(stale) ? stale : [];
}

// Interleave the three directories (gh, lever, ashby, gh, …) so every batch
// mixes vendors and no vendor's API gets 25 calls in a row.
export function buildRotationList(lists, excludeKeys = new Set(), ats = ATS) {
  const clean = ats.map((a) => [...new Set((lists[a] || []).map(String))].filter((s) => !excludeKeys.has(`${a}:${s.toLowerCase()}`)).sort());
  const out = [];
  const max = Math.max(0, ...clean.map((l) => l.length));
  for (let i = 0; i < max; i++) for (let j = 0; j < ats.length; j++) if (i < clean[j].length) out.push(`${ats[j]}:${clean[j][i]}`);
  return out;
}

/**
 * Drop boards already known to be dead: 3+ recorded HTTP 404 misses in
 * state/dead-boards.tsv, with a 30-day re-check so a revived board comes back.
 * recordRotationOutcomes() below keeps that file up to date.
 */
export function filterDeadBoards(list, deadRows, now = Date.now(), sources = SOURCES) {
  if (!deadRows || deadRows.size === 0) return { usable: list, skipped: 0 };
  const usable = [];
  let skipped = 0;
  for (const k of list) {
    const i = k.indexOf(':');
    const ats = k.slice(0, i);
    const entry = sources[ats]?.toEntry(k.slice(i + 1));
    if (entry && shouldSkipDeadBoard(deadRows, ats, entry.careers_url, now)) { skipped++; continue; }
    usable.push(k);
  }
  return { usable, skipped };
}

/**
 * After a batch: a board that answered resets its miss count, an HTTP 404
 * adds a miss, and any other failure (timeout, throttle, DNS) is "unknown"
 * and never counts towards dead. Unfinished boards are not touched.
 */
export function recordRotationOutcomes(rows, boards, res, now = Date.now()) {
  const byKey = new Map(boards.map((b) => [b.key, b]));
  const ats = (k) => k.slice(0, k.indexOf(':'));
  for (const k of res.done) { const b = byKey.get(k); if (b) recordBoardResult(rows, ats(k), b.entry.careers_url, 200, now); }
  for (const f of res.failures) {
    const b = byKey.get(f.board);
    if (b) recordBoardResult(rows, ats(f.board), b.entry.careers_url, f.reason === 'http' ? f.status : null, now);
  }
  return rows;
}

export function listHash(list) {
  return createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Pick this scan's batch. Retries (unfinished last time) first, then the next
 * slice from the cursor, wrapping at the end. The cursor advances by the slice
 * taken even if the scan is later cut short — a slow batch can't stall rotation.
 */
export function pickBatch(list, state, size) {
  const rot = { cursor: 0, retry: [], ...(state || {}) };
  const n = list.length;
  if (!n) return { batch: [], next: { ...rot, cursor: 0, total: 0 } };
  let cursor = Number.isInteger(rot.cursor) && rot.cursor >= 0 ? rot.cursor % n : 0;
  const inList = new Set(list);
  const retry = (rot.retry || []).filter((k) => inList.has(k)).slice(0, size);
  const batch = [...retry];
  const from = cursor;
  let taken = 0;
  while (batch.length < size && taken < n) {
    const k = list[(cursor + taken) % n];
    taken++;
    if (!batch.includes(k)) batch.push(k);
  }
  cursor = (cursor + taken) % n;
  return { batch, from, next: { cursor, retry: [], total: n, hash: listHash(list) } };
}

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

export default {
  id: 'ats-rotation',
  async run(ctx) {
    const { config, portals, signal } = ctx;
    const lists = ctx.rotationLists || {};
    // Presets may narrow the vendors (startup → ashby, lever); each vendor set
    // keeps its own rotation cursor so presets never disturb each other.
    const ats = (Array.isArray(config.rotationAts) ? config.rotationAts : ATS).filter((a) => ATS.includes(a));
    const stateKey = ats.join('+') === ATS.join('+') ? 'rotation' : `rotation:${ats.join('+')}`;
    for (const a of ats) if (!lists[a]) lists[a] = await loadList(a, config.atsCacheDir, ctx.fetchJson);
    // Exclude boards W1 already covers — no duplicate source coverage.
    const exclude = new Set();
    for (const e of portals.tracked_companies || []) {
      const b = boardFromCareersUrl(e?.careers_url);
      if (b) exclude.add(`${b.ats}:${b.slug.toLowerCase()}`);
    }
    const fullList = buildRotationList(lists, exclude, ats);
    const deadRows = ctx.deadBoards || loadDeadBoards(config.paths.deadBoards, ctx.now);
    const { usable: list, skipped: deadSkipped } = filterDeadBoards(fullList, deadRows, ctx.now);
    const state = loadState(config.stateFile);
    const { batch, from, next } = pickBatch(list, state[stateKey], config.rotationBatch);
    const boards = batch.map((key) => {
      const [ats, slug] = key.split(':');
      const entry = SOURCES[ats].toEntry(slug);
      return entry ? { entry, provider: SOURCES[ats].provider, key } : null;
    }).filter(Boolean);

    // Persist the advanced cursor up front so even a hard stop moves rotation on.
    saveState(config.stateFile, { ...state, [stateKey]: { ...next, retry: [], updated: new Date(ctx.now).toISOString() } });

    const res = await runBoards(boards, {
      signal, emit: ctx.emit, source: 'ats-rotation', prefilter: ctx.prefilter,
      concurrency: Math.min(config.boardConcurrency, 6), perBoardMs: config.perBoardMs, httpCtx: ctx.httpCtx,
    });
    saveState(config.stateFile, { ...loadState(config.stateFile), [stateKey]: { ...next, retry: res.unfinished, updated: new Date(ctx.now).toISOString() } });
    if (config.recordDeadBoards !== false && !ctx.deadBoards) {
      try { saveDeadBoards(config.paths.deadBoards, recordRotationOutcomes(deadRows, boards, res, ctx.now)); } catch { /* best effort */ }
    }
    return {
      ats, listSize: list.length, deadSkipped, from, batch: boards.length,
      done: res.done.length, failed: res.failed.length, unfinished: res.unfinished.length,
      jobs: res.jobs, excludedTracked: exclude.size, failures: res.failures,
    };
  },
};
