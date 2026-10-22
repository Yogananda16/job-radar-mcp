#!/usr/bin/env node
// main.mjs — the alert runner: one scan, then an email if anything new turned
// up. This is what the GitHub Actions schedule (and Task Scheduler) runs.
//
//   npm run alert                      # scan employer boards only ($0) and email new jobs
//   npm run alert -- --apify           # also search LinkedIn/Indeed via Apify (≤ $0.10)
//   npm run alert -- --dry-run         # scan + print the email; send nothing, save nothing
//   npm run alert -- --preset local    # any scan preset
//   npm run test-email                 # send a sample alert to check Gmail settings
//
// Flow: scan → pick rows (profile.yml alerts.email) → add pending rows from a
// failed send → optional AI notes → send → record in state/alerts.json.
// Exit codes: 0 ok (sent, or nothing new) · 1 scan failed · 2 email failed
// (rows kept as pending) · 3 bad usage.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { loadEnv } from './env.mjs';
import { runFreshScan } from './engine/run.mjs';
import { loadConfigForPreset } from './engine/config.mjs';
import { AlertLedger, selectAlertRows } from './alerts/ledger.mjs';
import { addFitNotes } from './ai/summarize.mjs';
import { renderHtml, renderText, subjectLine } from './notify/render.mjs';
import { sendEmail, emailSettings } from './notify/email.mjs';

const FLAGS = new Set(['--apify', '--no-apify', '--dry-run', '--test-email', '--help', '-h']);

export function parseArgs(argv) {
  const out = { apify: false, dryRun: false, testEmail: false, preset: 'run', help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') { out.preset = argv[++i] || 'run'; continue; }
    if (!FLAGS.has(a)) { out.unknown.push(a); continue; }
    if (a === '--apify') out.apify = true;
    if (a === '--no-apify') out.apify = false;
    if (a === '--dry-run') out.dryRun = true;
    if (a === '--test-email') out.testEmail = true;
    if (a === '--help' || a === '-h') out.help = true;
  }
  // The scheduled workflow sets RADAR_APIFY=1 on the runs that may spend money.
  if (process.env.RADAR_APIFY === '1') out.apify = true;
  return out;
}

const USAGE = 'npm run alert -- [--apify] [--dry-run] [--preset <name>] [--test-email]';

// Rows are stored in state/alerts.json when a send fails; keep them small.
const slim = ({ description, discoveryUrl, freshness, ...keep }) => keep;

function summaryLine(result, picked, sendResult, ai) {
  return [
    `scan ${(result.elapsedMs / 1000).toFixed(1)}s`,
    `found ${result.top.length}`,
    `alerting ${picked.length}`,
    `apify $${result.apify?.spentUsd ?? 0}`,
    ai?.costUsd ? `ai $${ai.costUsd.toFixed(4)}` : ai?.skipped ? `ai skipped (${ai.skipped})` : ai?.error ? `ai error (${ai.error})` : '',
    sendResult ? (sendResult.sent ? 'email sent' : `email ${sendResult.skipped || 'failed'}`) : '',
  ].filter(Boolean).join(' · ');
}

// GitHub Actions job summary (shown on the run page), when available.
function writeStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) try { fs.appendFileSync(file, md + '\n'); } catch { /* optional */ }
}

function runUrl() {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : '';
}

const SAMPLE = [{
  title: 'Machine Learning Engineer (sample)', company: 'Example Corp', location: 'New York, NY',
  salary: '$120K–$150K', fit: 4.6, eligibility: 'OK', posted: '2h ago (employer)',
  applyUrl: 'https://job-boards.greenhouse.io/example/jobs/1',
  ai: { fit: 'Sample note: strong match on Python, PyTorch and RAG.', gap: 'Sample note: asks for Kubernetes in production.' },
}];

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.unknown.length) {
    if (args.unknown.length) console.error(`Unknown option(s): ${args.unknown.join(' ')}`);
    console.error(USAGE);
    return args.unknown.length ? 3 : 0;
  }

  if (args.testEmail) {
    const s = emailSettings();
    if (!s.ok) { console.error(`Email is not configured: missing ${s.missing.join(', ')}. See docs/DEPLOYMENT.md.`); return 2; }
    const meta = { name: 'test', generated: new Date().toISOString(), runtimeS: 0, apifyUsd: 0 };
    const r = await sendEmail({ subject: '[job-radar] test email', html: renderHtml(SAMPLE, meta), text: renderText(SAMPLE, meta) });
    console.log(r.sent ? `Test email sent to ${s.to}.` : `Not sent: ${r.skipped}`);
    return r.sent ? 0 : 2;
  }

  const overrides = args.apify ? {} : { sources: { apify: false } };
  // A dry run must not move the rotation cursor either.
  if (args.dryRun) Object.assign(overrides, { stateFile: path.join(os.tmpdir(), `job-radar-state-${process.pid}.json`), recordDeadBoards: false });
  const config = loadConfigForPreset(args.preset, overrides);
  const alertCfg = config.raw.alerts?.email || {};
  const ledger = AlertLedger.load(path.join(config.paths.root, 'state/alerts.json'));

  let result;
  try {
    result = await runFreshScan({ config, persist: !args.dryRun });
  } catch (err) {
    console.error(`[job-radar] scan failed: ${err.message}`);
    return 1;
  }

  const fresh = selectAlertRows(result.top, { minFit: alertCfg.min_fit ?? 3.5, includeVerify: alertCfg.include_verify !== false });
  let rows = ledger.merge(fresh);
  if (alertCfg.enabled === false) rows = [];

  let ai = null;
  if (rows.length) {
    ai = await addFitNotes(rows, { profile: config.profile, candidate: config.raw.candidate, settings: config.raw.ai });
    rows = ai.rows;
  }

  const meta = {
    name: config.raw.candidate?.name, generated: result.generated, preset: result.preset?.name,
    runtimeS: (result.elapsedMs / 1000).toFixed(0), apifyUsd: Number(result.apify?.spentUsd || 0), aiUsd: ai?.costUsd || 0, runUrl: runUrl(),
  };

  let sendResult = null;
  let code = 0;
  if (rows.length && args.dryRun) {
    console.log(`--- email preview (${rows.length} jobs, not sent) ---\nSubject: ${subjectLine(rows, { prefix: alertCfg.subject_prefix })}\n\n${renderText(rows, meta)}`);
  } else if (rows.length) {
    try {
      sendResult = await sendEmail({
        subject: subjectLine(rows, { prefix: alertCfg.subject_prefix }),
        html: renderHtml(rows, meta),
        text: renderText(rows, meta),
      });
    } catch (err) {
      sendResult = { sent: false, skipped: `send failed: ${err.message}` };
    }
    if (sendResult.sent) ledger.markSent(rows);
    else { ledger.markPending(rows.map(slim)); code = 2; }
    ledger.save();
  }

  const line = summaryLine(result, rows, sendResult, ai);
  console.log(`[job-radar] ${line}`);
  writeStepSummary(`### job-radar\n${line}\n\n${rows.map((r) => `- **${r.title}**, ${r.company} (${r.location}), fit ${r.fit}: ${r.applyUrl}`).join('\n') || '_No new jobs this run._'}`);
  if (sendResult && !sendResult.sent) console.error(`[job-radar] ${sendResult.skipped}. ${rows.length} job(s) kept for the next run.`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Backstop: the scan stops itself at 5 minutes; this guarantees exit.
  const backstop = setTimeout(() => { console.error('[job-radar] backstop: exceeded time limit'); process.exit(4); }, 7 * 60_000);
  backstop.unref();
  main().then((code) => process.exit(code), (err) => { console.error(`[job-radar] ${err.stack || err.message}`); process.exit(1); });
}
