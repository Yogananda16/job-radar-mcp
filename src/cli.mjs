#!/usr/bin/env node
// cli.mjs — one scan, printed as a Markdown table: up to 10 verified,
// genuinely new (≤24h) jobs for the configured profile. No LLM involved.
//
//   npm run scan                         # = run: all enabled sources
//   npm run scan -- faang                # big tech / AI companies only
//   npm run scan -- staffing             # staffing firms only
//   npm run scan -- startup              # startup boards (Ashby/Lever rotation + tracked category: startup)
//   npm run scan -- remote               # Remote (US) only
//   npm run scan -- local                # your preferred locations + US-remote
//   npm run scan -- company Capital One
//   flags: --no-apify (=$0)  --tracked  --dry-run (save nothing)  --json  --probe
//
// Every preset is configuration for the same runFreshScan() pipeline and keeps
// every guardrail: strict final gate (NEW ≤24h per employer, never seen /
// reposted, live official page, official apply link, not BLOCKED, never
// padded), 90s / 3 min / 5 min limits, Apify ≤ $0.10 per scan (ceiling $0.25).
// The process exits when the scan returns — nothing keeps running.
import fs from 'fs';
import path from 'path';
import { loadEnv } from './env.mjs';
import { runFreshScan } from './engine/run.mjs';
import { loadConfigForPreset } from './engine/config.mjs';
import { renderMarkdown } from './engine/report.mjs';
import { parseCli, USAGE } from './engine/cli.mjs';

loadEnv();
const cli = parseCli(process.argv.slice(2));
if (cli.unknown.length || cli.help) {
  if (cli.unknown.length) console.error(`Unknown option(s): ${cli.unknown.join(' ')}`);
  console.error(USAGE);
  process.exit(cli.unknown.length ? 1 : 0);
}

let config;
try {
  config = loadConfigForPreset(cli.command, cli.overrides);
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
}

// Last-resort backstop: the scan enforces its own 5-minute stop; this only
// guarantees the process cannot outlive it by more than a few seconds.
const backstop = setTimeout(() => {
  console.error('[job-radar] backstop: exceeded hard limit, exiting');
  process.exit(4);
}, config.hardMs + 10_000);

try {
  const result = await runFreshScan({ config, persist: !cli.dryRun });
  if (cli.json) {
    process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  } else {
    process.stdout.write(renderMarkdown(result));
    const ap = result.sources?.apify;
    if (ap?.skipped) process.stdout.write(`\nApify skipped: ${ap.skipped}${ap.help ? `\n${ap.help}` : ''}\n`);
    const cb = result.sources?.['company-boards'];
    if (cb?.unresolved?.length) process.stdout.write(`\nNo confirmable official board (results for these come only from per-job verification): ${cb.unresolved.join(', ')}\n`);
    if (cli.probe && ap && !ap.skipped) {
      process.stdout.write(`\nProbe — Apify runs:\n${(ap.runs || []).map((r) => `  ${r.label}: ${r.status || r.error || r.skipped} · items ${r.items ?? 0} · kept ${r.kept ?? 0} · $${r.costUsd ?? 0}`).join('\n')}\n`);
      for (const [name, fields] of Object.entries(ap.sampleFields || {})) process.stdout.write(`  ${name} fields: ${fields.join(', ')}\n`);
      fs.writeFileSync(path.join(result.outDir, 'probe-raw.json'), JSON.stringify(ap.raw || {}, null, 1));
      process.stdout.write(`  raw items: ${path.join(result.outDir, 'probe-raw.json')}\n`);
    }
    process.stdout.write(`\nSaved: ${result.outDir}\n`);
  }
  clearTimeout(backstop);
  process.exit(0);
} catch (err) {
  console.error(`[job-radar] failed: ${err.message}`);
  process.exit(1);
}
