// ledger.mjs — which jobs have already been emailed, and which are waiting.
//
// File: state/alerts.json
//   { "sent":    { "<key>": "<ISO time>" },   jobs already emailed (pruned after 30 days)
//     "pending": [ <row>, … ] }                jobs found but not delivered yet
//
// The scan marks every job it returns as seen, so a job whose email failed
// would never come back. Undelivered rows go to `pending` and are retried on
// the next run, so a Gmail outage loses nothing.
import fs from 'fs';
import path from 'path';

const KEEP_SENT_DAYS = 30;
const MAX_PENDING = 50;

export function alertKey(row) {
  return String(row.applyUrl || `${row.company}|${row.title}|${row.location}`).toLowerCase();
}

export class AlertLedger {
  constructor(file, data = {}) {
    this.file = file;
    this.sent = data.sent && typeof data.sent === 'object' ? data.sent : {};
    this.pending = Array.isArray(data.pending) ? data.pending : [];
  }

  static load(file) {
    try {
      return new AlertLedger(file, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return new AlertLedger(file);
    }
  }

  /** Pending rows first, then new rows; nothing already sent, no duplicates. */
  merge(rows) {
    const out = [];
    const keys = new Set();
    for (const r of [...this.pending, ...rows]) {
      const k = alertKey(r);
      if (this.sent[k] || keys.has(k)) continue;
      keys.add(k);
      out.push(r);
    }
    return out;
  }

  markSent(rows, now = Date.now()) {
    const sentKeys = new Set(rows.map(alertKey));
    for (const k of sentKeys) this.sent[k] = new Date(now).toISOString();
    this.pending = this.pending.filter((r) => !sentKeys.has(alertKey(r)));
  }

  markPending(rows) {
    this.pending = this.merge(rows).slice(0, MAX_PENDING);
  }

  save(now = Date.now()) {
    const cutoff = now - KEEP_SENT_DAYS * 86_400_000;
    for (const [k, t] of Object.entries(this.sent)) if (Date.parse(t) < cutoff) delete this.sent[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sent: this.sent, pending: this.pending }, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Which scan rows are worth an email, per profile.yml → alerts.email.
 * @param {object[]} rows   scan result rows, best first
 * @param {object}   opts   { minFit = 3.5, includeVerify = true }
 */
export function selectAlertRows(rows, { minFit = 3.5, includeVerify = true } = {}) {
  return rows.filter((r) => r.applyUrl
    && Number(r.fit) >= minFit
    && (r.eligibility === 'OK' || (includeVerify && r.eligibility === 'VERIFY')));
}
