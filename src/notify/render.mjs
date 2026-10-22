// render.mjs — the alert email, as HTML and plain text. Pure functions.
//
// Input rows are scan result rows (engine/run.mjs toRow) plus an optional
// `ai` note ({ fit, gap }) added by src/ai/summarize.mjs.

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtFit = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');

export function subjectLine(rows, { prefix = '[job-radar]' } = {}) {
  if (!rows.length) return `${prefix} no new jobs`;
  const best = rows[0];
  const more = rows.length > 1 ? ` + ${rows.length - 1} more` : '';
  return `${prefix} ${rows.length} new job${rows.length === 1 ? '' : 's'}: ${best.title} at ${best.company}${more}`;
}

function eligibilityBadge(row) {
  if (row.eligibility === 'OK') return '<span style="color:#1a7f37">OK</span>';
  const note = row.eligibilityNote ? ` title="${escHtml(row.eligibilityNote)}"` : '';
  return `<span style="color:#9a6700"${note}>VERIFY</span>`;
}

/**
 * @param {object[]} rows      jobs to announce, best first
 * @param {object}   meta      { name, generated, preset, runtimeS, apifyUsd, aiUsd, runUrl }
 */
export function renderHtml(rows, meta = {}) {
  const cell = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:14px';
  const head = 'padding:8px 10px;border-bottom:2px solid #d1d5db;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase';
  const body = rows.map((r) => `
      <tr>
        <td style="${cell}"><strong>${escHtml(r.title)}</strong><br><span style="color:#4b5563">${escHtml(r.company)}</span>${r.ai ? `<div style="margin-top:6px;color:#374151;font-size:13px">✅ ${escHtml(r.ai.fit)}<br>⚠️ ${escHtml(r.ai.gap)}</div>` : ''}</td>
        <td style="${cell}">${escHtml(r.location)}</td>
        <td style="${cell}">${escHtml(r.salary)}</td>
        <td style="${cell};text-align:center"><strong>${fmtFit(r.fit)}</strong></td>
        <td style="${cell}">${eligibilityBadge(r)}</td>
        <td style="${cell};white-space:nowrap">${escHtml(r.posted)}</td>
        <td style="${cell}"><a href="${escHtml(r.applyUrl)}" style="background:#2563eb;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none">Apply</a></td>
      </tr>`).join('');
  const when = meta.generated ? new Date(meta.generated).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' : '';
  const costs = [`Apify $${(meta.apifyUsd ?? 0).toFixed(3)}`, ...(meta.aiUsd ? [`AI $${meta.aiUsd.toFixed(3)}`] : [])].join(' · ');
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:960px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px">
    <h2 style="margin:0 0 4px">${rows.length} new job${rows.length === 1 ? '' : 's'} for you${meta.name ? `, ${escHtml(meta.name)}` : ''}</h2>
    <p style="margin:0 0 16px;color:#6b7280;font-size:13px">${escHtml(when)}${meta.preset && meta.preset !== 'run' ? ` · preset ${escHtml(meta.preset)}` : ''}</p>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr>
        <th style="${head}">Role</th><th style="${head}">Location</th><th style="${head}">Salary</th>
        <th style="${head}">Fit /5</th><th style="${head}">Eligibility</th><th style="${head}">Posted</th><th style="${head}"></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.5">
      Every job was first posted ≤24h ago per the employer's own careers site, has never been seen before (no reposts),
      and links to the official application page. VERIFY = sponsorship or clearance wording you should read yourself.<br>
      Scan took ${meta.runtimeS ?? '?'}s · ${escHtml(costs)}${meta.runUrl ? ` · <a href="${escHtml(meta.runUrl)}">run log</a>` : ''}
    </p>
  </div>
</body></html>`;
}

export function renderText(rows, meta = {}) {
  const lines = [`${rows.length} new job${rows.length === 1 ? '' : 's'}${meta.name ? ` for ${meta.name}` : ''}`, ''];
  for (const r of rows) {
    lines.push(`${r.title} — ${r.company}`);
    lines.push(`  ${r.location} · ${r.salary} · fit ${fmtFit(r.fit)} · ${r.eligibility} · ${r.posted}`);
    if (r.ai) lines.push(`  + ${r.ai.fit}`, `  - ${r.ai.gap}`);
    lines.push(`  Apply: ${r.applyUrl}`, '');
  }
  lines.push(`Scan took ${meta.runtimeS ?? '?'}s · Apify $${(meta.apifyUsd ?? 0).toFixed(3)}`);
  return lines.join('\n');
}
