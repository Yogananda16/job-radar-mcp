// Alert pipeline: ledger, row selection, email rendering/sending, AI notes.
// No network: the SMTP transport and the Anthropic client are mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { AlertLedger, alertKey, selectAlertRows } from '../src/alerts/ledger.mjs';
import { renderHtml, renderText, subjectLine } from '../src/notify/render.mjs';
import { sendEmail, emailSettings } from '../src/notify/email.mjs';
import { addFitNotes, estimateCostUsd, jobsBlock } from '../src/ai/summarize.mjs';
import { DEFAULT_PROFILE, normalizeProfile } from '../src/engine/profile.mjs';
import { parseArgs } from '../src/main.mjs';
import { tmpDir } from './helpers.mjs';

const row = (i, patch = {}) => ({
  title: `ML Engineer ${i}`, company: `Acme ${i}`, location: 'New York, NY', salary: '$120K–$150K',
  fit: 4.5, eligibility: 'OK', posted: '2h ago (employer)', applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${i}`,
  description: 'Build ML systems with Python and PyTorch.', ...patch,
});

test('selectAlertRows: min fit, eligibility, apply link', () => {
  const rows = [row(1), row(2, { fit: 3.0 }), row(3, { eligibility: 'VERIFY' }), row(4, { eligibility: 'BLOCKED' }), row(5, { applyUrl: '' })];
  assert.deepEqual(selectAlertRows(rows).map((r) => r.title), ['ML Engineer 1', 'ML Engineer 3']);
  assert.deepEqual(selectAlertRows(rows, { includeVerify: false }).map((r) => r.title), ['ML Engineer 1']);
  assert.deepEqual(selectAlertRows(rows, { minFit: 2.5 }).length, 3);
});

test('ledger: never re-sends; failed sends become pending and are retried first', () => {
  const file = path.join(tmpDir(), 'alerts.json');
  const l1 = AlertLedger.load(file);
  assert.deepEqual(l1.merge([row(1), row(2)]).length, 2);
  l1.markSent([row(1)]);
  l1.markPending([row(2)]);
  l1.save();

  const l2 = AlertLedger.load(file);
  const next = l2.merge([row(1), row(3)]);
  assert.deepEqual(next.map((r) => r.title), ['ML Engineer 2', 'ML Engineer 3'], 'pending first, sent skipped');
  l2.markSent(next);
  assert.equal(l2.pending.length, 0);
  assert.ok(l2.sent[alertKey(row(3))]);
});

test('ledger: sent entries older than 30 days are pruned on save', () => {
  const file = path.join(tmpDir(), 'alerts.json');
  const l = new AlertLedger(file, { sent: { old: '2020-01-01T00:00:00Z', recent: new Date().toISOString() } });
  l.save();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sent), ['recent']);
});

test('render: subject, HTML escaping, AI notes, plain text', () => {
  const rows = [row(1, { title: 'AI <Engineer>', ai: { fit: 'Python match', gap: 'No Go' } }), row(2)];
  assert.equal(subjectLine(rows), '[job-radar] 2 new jobs: AI <Engineer> at Acme 1 + 1 more');
  assert.equal(subjectLine([row(1)], { prefix: '[x]' }), '[x] 1 new job: ML Engineer 1 at Acme 1');
  const html = renderHtml(rows, { name: 'Sam', runtimeS: 30, apifyUsd: 0.05 });
  assert.match(html, /AI &lt;Engineer&gt;/);
  assert.doesNotMatch(html, /AI <Engineer>/);
  assert.match(html, /Python match/);
  assert.match(html, /href="https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\/2"/);
  const text = renderText(rows, {});
  assert.match(text, /Apply: https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\/1/);
});

test('email: missing credentials → skipped, never thrown; configured → sent via transport', async () => {
  assert.deepEqual(emailSettings({}).missing, ['GMAIL_USER', 'GMAIL_APP_PASSWORD']);
  const r = await sendEmail({ subject: 's', html: 'h', text: 't' }, { env: {} });
  assert.equal(r.sent, false);
  assert.match(r.skipped, /GMAIL_USER/);

  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: 'id-1' }; } };
  const env = { GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'ab12 cd34 ef56 gh78' };
  const ok = await sendEmail({ subject: 's', html: 'h', text: 't' }, { env, transport });
  assert.deepEqual(ok, { sent: true, id: 'id-1' });
  assert.equal(sent[0].to, 'me@gmail.com', 'ALERT_TO defaults to the sender');
  assert.equal(emailSettings(env).pass, 'ab12cd34ef56gh78', 'spaces in the app password are ignored');
});

test('ai: skipped without a key; notes attached by index from structured output', async () => {
  const none = await addFitNotes([row(1)], { profile: DEFAULT_PROFILE, env: {} });
  assert.equal(none.skipped, 'ANTHROPIC_API_KEY not set');
  assert.equal(none.rows[0].ai, undefined);

  let request;
  const client = { beta: { messages: { parse: async (req) => {
    request = req;
    return {
      model: 'claude-opus-5-5', stop_reason: 'end_turn',
      usage: { input_tokens: 2000, output_tokens: 200 },
      parsed_output: { notes: [{ index: 1, fit: 'Strong PyTorch match', gap: 'No Kubernetes' }, { index: 7, fit: 'x', gap: 'y' }] },
    };
  } } } };
  const out = await addFitNotes([row(1), row(2)], { profile: DEFAULT_PROFILE, candidate: { name: 'Sam' }, settings: {}, client });
  assert.equal(out.rows[0].ai, undefined);
  assert.deepEqual(out.rows[1].ai, { fit: 'Strong PyTorch match', gap: 'No Kubernetes' });
  assert.ok(Math.abs(out.costUsd - (2000 * 4 + 200 * 20) / 1e6) < 1e-9);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.fallbacks, 'default');
  assert.equal(request.output_config.effort, 'low');
  assert.match(request.system[1].text, /Candidate: Sam/);
  assert.ok(request.system[1].cache_control, 'profile prefix is cacheable');
});

test('ai: errors and refusals never block the alert', async () => {
  const failing = { beta: { messages: { parse: async () => { throw new Error('boom'); } } } };
  const r1 = await addFitNotes([row(1)], { profile: DEFAULT_PROFILE, client: failing });
  assert.match(r1.error, /boom/);
  assert.equal(r1.rows.length, 1);
  const refusing = { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', usage: {}, parsed_output: null }) } } };
  const r2 = await addFitNotes([row(1)], { profile: DEFAULT_PROFILE, client: refusing });
  assert.match(r2.error, /declined/);
  const haiku = { beta: { messages: { parse: async (req) => { assert.equal(req.fallbacks, undefined); return { stop_reason: 'end_turn', usage: {}, parsed_output: { notes: [] } }; } } } };
  await addFitNotes([row(1)], { profile: DEFAULT_PROFILE, settings: { model: 'claude-haiku-5-5' }, client: haiku });
});

test('ai: job text is capped per job; cost estimate covers cache tokens', () => {
  const long = 'x'.repeat(20_000);
  assert.ok(jobsBlock([row(1, { description: long })]).length < 6_300);
  assert.equal(estimateCostUsd('unknown-model', { input_tokens: 1 }), null);
  const c = estimateCostUsd('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 100 });
  assert.ok(Math.abs(c - (1000 * 0.1 + 100 * 0.1 + 100 * 0.5) / 1e6) < 1e-12);
});

test('profile: custom roles, locations, eligibility switches', async () => {
  const { checkEligibility } = await import('../src/engine/eligibility.mjs');
  const { titleFit } = await import('../src/engine/score.mjs');
  const p = normalizeProfile({
    roles: [{ label: 'Frontend', tier: 'primary', keywords: ['frontend', 'react'] }],
    eligibility: { needs_sponsorship: false, us_citizen: true, max_years_required: 8, graduation: 'none' },
  });
  assert.equal(titleFit('Senior React Developer', p).label, 'Frontend');
  assert.equal(titleFit('Data Scientist', p).tier, 'other');
  const pad = (s) => `${s} ${'Build web apps with React and TypeScript every day. '.repeat(6)}`;
  const job = (d) => ({ title: 'Frontend Engineer', description: pad(d) });
  assert.equal(checkEligibility(job('We will not sponsor visas now or in the future.'), p).eligibility, 'OK');
  assert.equal(checkEligibility(job('Applicants must be a U.S. citizen with an active Secret clearance.'), p).eligibility, 'OK');
  assert.equal(checkEligibility(job('Requires 7+ years of experience.'), p).eligibility, 'OK');
  assert.equal(checkEligibility(job('Requires 7+ years of experience.')).eligibility, 'BLOCKED', 'defaults unchanged');
  const grad = normalizeProfile({ eligibility: { graduation: '2027-12' } });
  assert.equal(checkEligibility(job('Must be graduating in 2028.'), grad).eligibility, 'BLOCKED');
  assert.equal(checkEligibility(job('Graduating by December 2027.'), grad).eligibility, 'OK');
});

test('main: argument parsing', () => {
  const prev = process.env.RADAR_APIFY;
  delete process.env.RADAR_APIFY;
  assert.deepEqual(parseArgs(['--dry-run', '--preset', 'local']), { apify: false, dryRun: true, testEmail: false, preset: 'local', help: false, unknown: [] });
  assert.equal(parseArgs(['--apify']).apify, true);
  assert.deepEqual(parseArgs(['--nope']).unknown, ['--nope']);
  process.env.RADAR_APIFY = '1';
  assert.equal(parseArgs([]).apify, true, 'the scheduled workflow turns Apify on via RADAR_APIFY=1');
  if (prev === undefined) delete process.env.RADAR_APIFY; else process.env.RADAR_APIFY = prev;
});
