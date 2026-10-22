// cli.mjs — parse `npm run scan -- <preset> [flags]` arguments (pure; tested).
//   <preset>: run | faang | staffing | startup | remote | local | company <name> | any preset in profile.yml
//   flags:    --no-apify --tracked --dry-run --json --probe --help
import path from 'path';
import os from 'os';

const ROTATION_FLAG_RE = /^--rotation-batch=\d+$/;
export const FLAGS = new Set(['--no-apify', '--tracked', '--dry-run', '--json', '--probe', '--help', '-h']);
export const USAGE = [
  'npm run scan -- [preset] [flags]      (or: node src/cli.mjs [preset] [flags])',
  '  presets: run (default) · faang · staffing · startup · remote · local · company <name>',
  '  flags:   --no-apify  --tracked  --dry-run  --json  --probe  --rotation-batch=N  --help',
].join('\n');

export function parseCli(argv, { pid = process.pid, tmpdir = os.tmpdir() } = {}) {
  const flags = argv.filter((a) => a.startsWith('-'));
  const words = argv.filter((a) => !a.startsWith('-'));
  const unknown = flags.filter((f) => !FLAGS.has(f) && !ROTATION_FLAG_RE.test(f));
  const help = flags.includes('--help') || flags.includes('-h');
  const command = words.length ? words.join(' ') : 'run';

  const overrides = {};
  if (flags.includes('--no-apify')) overrides.sources = { apify: false };
  if (flags.includes('--tracked')) overrides.sources = { tracked: true, 'ats-rotation': false, apify: false, 'company-boards': false };
  // --probe: the smallest possible real Apify check — Apify only, one query,
  // 5 results per actor, $0.02 cap for the whole scan, nothing persisted.
  const probe = flags.includes('--probe');
  if (probe) {
    overrides.sources = { tracked: false, 'ats-rotation': false, apify: true, 'company-boards': false };
    overrides.enrich = false;
    overrides.apify = {
      scanCapUsd: 0.02, perRunCapUsd: 0.01, warnUsd: 0.02, captureRaw: true,
      queries: { primary: ['Data Scientist'], secondary: [], adjacent: [] },
      actors: { linkedin: { limitPerQuery: 5 }, indeed: { limitPerQuery: 5 } },
    };
  }
  // --rotation-batch=N: rotating boards for this run only (config clamps to ≤50).
  const rb = flags.find((f) => ROTATION_FLAG_RE.test(f));
  if (rb) overrides.rotationBatch = Number(rb.split('=')[1]);
  const dryRun = flags.includes('--dry-run') || probe;
  if (dryRun) { overrides.stateFile = path.join(tmpdir, `job-radar-state-${pid}.json`); overrides.recordDeadBoards = false; }
  return { command, overrides, dryRun, probe, json: flags.includes('--json'), help, unknown };
}
