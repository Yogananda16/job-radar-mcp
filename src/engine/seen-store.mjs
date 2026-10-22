// seen-store.mjs — persistent first-seen database for discovery.
//
// Answers one question per job: "have we seen this posting (or a near-copy of
// it) before, and since when?" A LinkedIn refresh changes the displayed age but
// not the job id / URL / company+title+location / description, so any of those
// matching an older record pins the job to its ORIGINAL first-seen time.
//
// File: state/job-seen.json (kept between runs). Also reads, when present,
// a career-ops scan-history.tsv read-only, so everything those scanners have
// recorded counts as "seen" from the very first discovery run.
import fs from 'fs';
import path from 'path';
import { fingerprintText, similarity } from '../vendor/fingerprint-core.mjs';
import { parseScanHistoryLine } from '../vendor/lib/scan-history-columns.mjs';
import { identityKeys, ctlKey, companyKey, canonicalUrl } from './job.mjs';

const DAY = 86_400_000;
const PRUNE_AFTER_DAYS = 180;
const FP_REPOST_THRESHOLD = 0.92;

function endOfLocalDay(dateStr) {
  // scan-history only stores a calendar day. Use the LATEST moment of that day
  // so an entry is never judged older than it can actually be.
  const t = Date.parse(`${dateStr}T23:59:59`);
  return Number.isFinite(t) ? t : null;
}

export function historyRecords(historyText) {
  const out = [];
  const lines = String(historyText || '').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseScanHistoryLine(lines[i]);
    const firstSeen = endOfLocalDay(row.first_seen);
    const urlKey = canonicalUrl(row.url);
    if (!firstSeen || !urlKey) continue;
    const ctl = ctlKey({ company: row.company, title: row.title, location: row.location });
    out.push({
      keys: [`url:${urlKey}`],
      ctl,
      fp: row.fingerprint || '',
      company: row.company, title: row.title, location: row.location,
      source: 'scan-history',
      firstSeen,
      lastSeen: firstSeen,
      historyOnly: true,
    });
  }
  return out;
}

export class SeenStore {
  constructor({ file = null, records = [], history = [] } = {}) {
    this.file = file;
    this.records = records;          // persisted
    this.history = history;          // read-only seed from scan-history.tsv
    this.reindex();
  }

  static load(file, { historyPath = null } = {}) {
    let records = [];
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data?.version === 1 && Array.isArray(data.records)) records = data.records;
      } catch {
        // A corrupt store must not kill a scan; keep a copy and start fresh.
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      }
    }
    let history = [];
    if (historyPath && fs.existsSync(historyPath)) {
      history = historyRecords(fs.readFileSync(historyPath, 'utf8'));
    }
    return new SeenStore({ file, records, history });
  }

  indexFp(r) {
    if (!r.fp) return;
    const ck = companyKey(r.company);
    if (!ck) return;
    if (!this.byCompanyFp.has(ck)) this.byCompanyFp.set(ck, []);
    const list = this.byCompanyFp.get(ck);
    if (!list.includes(r)) list.push(r);
  }

  reindex() {
    this.byKey = new Map();
    this.byCtl = new Map();
    this.byCompanyFp = new Map();
    for (const r of [...this.history, ...this.records]) {
      this.indexFp(r);
      for (const k of r.keys || []) {
        const prev = this.byKey.get(k);
        if (!prev || r.firstSeen < prev.firstSeen) this.byKey.set(k, r);
      }
      if (r.ctl) {
        if (!this.byCtl.has(r.ctl)) this.byCtl.set(r.ctl, []);
        this.byCtl.get(r.ctl).push(r);
      }
    }
  }

  /**
   * strong: records sharing a source id or canonical URL — the same posting.
   * weak:   records with the same company+title+location, or a near-identical
   *         description at the same company, but a different id/URL — a repost.
   */
  lookup(job) {
    const strong = new Set();
    for (const k of identityKeys(job)) {
      const r = this.byKey.get(k);
      if (r) strong.add(r);
    }
    const weak = new Set();
    const ctl = ctlKey(job);
    if (ctl) for (const r of this.byCtl.get(ctl) || []) if (!strong.has(r)) weak.add(r);
    const fp = job.description ? fingerprintText(job.description) : '';
    if (fp) {
      for (const r of this.byCompanyFp.get(companyKey(job.company)) || []) {
        if (strong.has(r) || weak.has(r)) continue;
        if (similarity(fp, r.fp) >= FP_REPOST_THRESHOLD) weak.add(r);
      }
    }
    const min = (set) => set.size ? Math.min(...[...set].map((r) => r.firstSeen)) : null;
    return { strong: [...strong], weak: [...weak], strongFirstSeen: min(strong), weakFirstSeen: min(weak), fp };
  }

  // Record a job observation. firstSeen never moves forward.
  upsert(job, now, extra = {}) {
    const keys = identityKeys(job);
    let rec = null;
    for (const k of keys) {
      const r = this.byKey.get(k);
      if (r && !r.historyOnly) { rec = r; break; }
    }
    const fp = job.description ? fingerprintText(job.description) : '';
    if (!rec) {
      const histFirst = keys.map((k) => this.byKey.get(k)?.firstSeen).filter(Boolean);
      rec = {
        keys: [],
        ctl: ctlKey(job),
        fp,
        company: job.company, title: job.title, location: job.location,
        source: job.source,
        firstSeen: Math.min(now, ...histFirst),
        lastSeen: now,
      };
      this.records.push(rec);
      this.indexFp(rec);
    }
    rec.keys = [...new Set([...(rec.keys || []), ...keys])];
    rec.lastSeen = Math.max(rec.lastSeen || 0, now);
    if (!rec.fp && fp) { rec.fp = fp; this.indexFp(rec); }
    if (!rec.ctl) rec.ctl = ctlKey(job);
    if (job.postedEvidence === 'ats_first_published' && job.postedAt) {
      rec.firstPostedAt = Math.min(rec.firstPostedAt ?? Infinity, job.postedAt);
    }
    Object.assign(rec, extra);
    for (const k of rec.keys) {
      const prev = this.byKey.get(k);
      if (!prev || prev.historyOnly || prev === rec) this.byKey.set(k, rec);
    }
    if (rec.ctl) {
      const list = this.byCtl.get(rec.ctl) || [];
      if (!list.includes(rec)) list.push(rec);
      this.byCtl.set(rec.ctl, list);
    }
    return rec;
  }

  // Source ids already known for one source (e.g. LinkedIn ids to skip paying for).
  knownSourceIds(source, { sinceMs = 0, max = 200 } = {}) {
    const prefix = `id:${source}:`;
    const ids = [];
    for (const r of this.records) {
      if ((r.lastSeen || 0) < sinceMs) continue;
      for (const k of r.keys || []) if (k.startsWith(prefix)) ids.push([r.lastSeen, k.slice(prefix.length)]);
    }
    return ids.sort((a, b) => b[0] - a[0]).slice(0, max).map(([, id]) => id);
  }

  save(now = Date.now()) {
    if (!this.file) return;
    const cutoff = now - PRUNE_AFTER_DAYS * DAY;
    const records = this.records.filter((r) => (r.lastSeen || 0) >= cutoff);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved: new Date(now).toISOString(), records }));
    fs.renameSync(tmp, this.file);
  }
}
