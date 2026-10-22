// apify-util.mjs — small helpers shared by the Apify adapters.

export function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
    if (v != null && v !== '') return v;
  }
  return undefined;
}

// "3 hours ago", "30+ days ago", "Just now", "Today" → epoch ms (or null).
export function parseRelativeAge(text, now) {
  const s = String(text || '').toLowerCase().trim();
  if (!s) return null;
  if (/just now|moments? ago|today/.test(s)) return now;
  const m = s.match(/(\d+)\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 864e5, week: 6048e5, month: 2592e6 }[m[2]];
  return now - n * unit;
}
