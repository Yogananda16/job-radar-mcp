#!/usr/bin/env node
// check-secrets.mjs — fail if a credential-looking string is in a tracked file.
// Runs in CI on every push and pull request (npm run check:secrets).
import { execFileSync } from 'child_process';
import fs from 'fs';

const PATTERNS = [
  [/apify_api_[A-Za-z0-9]{20,}/, 'Apify API token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/GMAIL_APP_PASSWORD\s*[=:]\s*['"]?[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}\b/i, 'Gmail App Password'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];
const SKIP = /(^|\/)(package-lock\.json|node_modules\/)|\.(png|jpg|gif|ico|pdf)$/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f && !SKIP.test(f));
const hits = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    for (const [re, label] of PATTERNS) if (re.test(line)) hits.push(`${f}:${i + 1}  ${label}`);
  });
}
if (hits.length) {
  console.error(`Possible secrets in tracked files:\n  ${hits.join('\n  ')}\nMove them to .env (local) or GitHub secrets.`);
  process.exit(1);
}
console.log(`No secrets found in ${files.length} tracked files.`);
