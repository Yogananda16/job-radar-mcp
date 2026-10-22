// report.mjs — the short, actionable Markdown view of a scan result.

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderMarkdown(r) {
  const when = new Date(r.generated).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const preset = r.preset?.name && r.preset.name !== 'run' ? ` — preset: ${r.preset.name}` : '';
  const lines = [
    `# Fresh jobs — ${r.top.length} verified${preset} — ${when} ET`,
    '',
  ];
  if (r.partial) lines.push(`> ⚠ Partial result: ${r.stopReason}. Showing the best found so far.`, '');
  if (r.apify?.warn) lines.push(`> ⚠ Apify spend $${r.apify.spentUsd} reached the warning threshold.`, '');
  if (!r.top.length) {
    lines.push('No job passed the strict bar (new ≤24h at the employer, not seen/reposted, live official page, employer apply link, eligible). Nothing is padded in.');
  } else {
    lines.push(
      '| Posted | Fit /5 | Company | Job Title | Location | Salary | Eligibility | Why it matches | Apply |',
      '|---|---|---|---|---|---|---|---|---|',
      ...r.top.map((t) => `| ${esc(t.posted)} | ${t.fit} | ${esc(t.company)} | ${esc(t.title)} | ${esc(t.location)} | ${esc(t.salary)} | ${t.eligibility}${t.eligibilityNote ? ` — "${esc(t.eligibilityNote).slice(0, 80)}"` : ''} | ${esc(t.why)} | [Apply](${t.applyUrl}) |`),
    );
  }
  const ex = Object.entries(r.counts.excluded || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const ages = Object.entries(r.counts.ageBreakdown || {}).filter(([, v]) => v.total)
    .map(([k, v]) => `${k} ${v.total}${v.employerDated !== v.total ? ` (${v.employerDated} employer-dated)` : ''}`).join(' · ');
  const f = r.failures;
  const failLine = f?.total
    ? `Board failures: ${f.total} — ${Object.entries(f.byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')}. Slowest: ${f.list.slice(0, 3).map((x) => `${x.company || x.board} (${x.provider}, ${x.reason}${x.status ? ` ${x.status}` : ''}, ${(x.elapsedMs / 1000).toFixed(1)}s)`).join('; ')}.`
    : 'Board failures: none.';
  const rot = r.sources?.['ats-rotation'];
  lines.push(
    '',
    `Collected ${r.counts.collected} · evaluated ${r.counts.evaluated} · shortlisted ${r.counts.shortlisted}. Excluded: ${ex || 'none'}.`,
    `Age of evaluated jobs (diagnostic; Top 10 needs a credible ≤24h date): ${ages || 'none'}.`,
    failLine,
    ...(rot && !rot.skipped ? [`Rotation: ${rot.batch} boards (from #${(rot.from ?? 0) + 1} of ${rot.listSize} usable; ${rot.deadSkipped ?? 0} known-dead skipped).`] : []),
    `Runtime ${(r.elapsedMs / 1000).toFixed(1)}s${r.earlyStop ? ' (early stop)' : ''} · Apify $${r.apify?.spentUsd ?? 0} (cap $${r.apify?.capUsd ?? 0}) · LLM $0.`,
    '',
    'Every row: first posted ≤24h per the employer\'s own ATS, never seen before (no reposts/refreshes), live on the official page in this scan, and the Apply link is the official employer/ATS URL. LinkedIn/Indeed are discovery only. Eligibility VERIFY = ambiguous sponsorship/clearance wording to check.',
  );
  return lines.join('\n') + '\n';
}
