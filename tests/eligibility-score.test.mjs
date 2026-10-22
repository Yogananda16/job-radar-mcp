import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEligibility, parseSalaryK } from '../src/engine/eligibility.mjs';
import { scoreJob, loadCvSkills, WEIGHTS, titleFit } from '../src/engine/score.mjs';
import { atsJob, SKILLS, GOOD_JD } from './helpers.mjs';

const pad = (s) => `${s} ${'Build data and machine learning systems with Python and SQL. '.repeat(5)}`;

test('blocks: no sponsorship now or in the future', () => {
  const e = checkEligibility(atsJob(1, { description: pad('We will not sponsor applicants for work visas now or in the future.') }));
  assert.equal(e.eligibility, 'BLOCKED');
  assert.match(e.blocked[0].reason, /sponsorship/);
});

test('blocks: US citizens only, OPT excluded, enrollment', () => {
  for (const s of ['Applicants must be a U.S. citizen.', 'We do not accept OPT or CPT candidates.', 'Candidates must be currently enrolled in a degree program.']) {
    assert.equal(checkEligibility(atsJob(1, { description: pad(s) })).eligibility, 'BLOCKED', s);
  }
});

// Clearance rules: hard stop only when US citizenship is explicitly required.
test('clearance + explicit US citizenship requirement → BLOCKED', () => {
  for (const s of [
    'An active Secret clearance is required. U.S. citizenship is required.',
    'This position requires a security clearance, which requires U.S. citizenship',
    'U.S. citizenship is required to be eligible for a security clearance',
    'Must be a US citizen with an active TS/SCI clearance.',
    'You have: United States Citizenship (essential to comply with government contract requirements). Ability to obtain a security clearance.',
  ]) {
    const e = checkEligibility(atsJob(1, { description: pad(s) }));
    assert.equal(e.eligibility, 'BLOCKED', s);
  }
});

test('clearance required, citizenship unstated → VERIFY (not BLOCKED)', () => {
  for (const s of [
    'An active Secret clearance is required.',
    'Security Clearance: A current government clearance, background investigation, and polygraph are required.',
    'Active TS/SCI with full-scope polygraph is mandatory.',
  ]) {
    const e = checkEligibility(atsJob(1, { description: pad(s) }));
    assert.equal(e.eligibility, 'VERIFY', s);
    assert.ok(e.verify.some((v) => /clearance|polygraph/.test(v.reason)), s);
  }
});

test('"Employee Polygraph Protection Act (EPPA)" legal notice is not a polygraph requirement', () => {
  const s = 'Know your rights: Equal Employment Opportunity (EEO) - Employee Polygraph Protection Act (EPPA) - Family and Medical Leave Act.';
  assert.equal(checkEligibility(atsJob(1, { description: pad(s) })).eligibility, 'OK');
  assert.equal(checkEligibility(atsJob(1, { description: pad('Candidates must pass a full-scope polygraph.') })).eligibility, 'VERIFY');
});

test('EEO boilerplate ("citizen status") is not a citizenship requirement', () => {
  const s = 'We do not discriminate on the basis of race, national origin, citizen status, veteran status, or any other protected classification.';
  assert.equal(checkEligibility(atsJob(1, { description: pad(s) })).eligibility, 'OK');
});

test('public trust / ability to obtain clearance, citizenship unclear → VERIFY', () => {
  for (const s of [
    'Candidates must be able to obtain a Public Trust clearance.',
    'Ability to obtain and maintain a security clearance.',
    'Must be eligible to obtain a government clearance.',
  ]) {
    assert.equal(checkEligibility(atsJob(1, { description: pad(s) })).eligibility, 'VERIFY', s);
  }
});

test('blocks: 6+ years, Staff/Principal/Manager titles, stated ceiling below $70K', () => {
  assert.equal(checkEligibility(atsJob(1, { description: pad('Requires 7+ years of experience in ML.') })).eligibility, 'BLOCKED');
  assert.equal(checkEligibility(atsJob(1, { title: 'Staff Machine Learning Engineer' })).eligibility, 'BLOCKED');
  assert.equal(checkEligibility(atsJob(1, { description: pad('Pay range: $50,000 - $65,000 per year.') })).eligibility, 'BLOCKED');
});

test('VERIFY: ambiguous sponsorship wording; no job text', () => {
  assert.equal(checkEligibility(atsJob(1, { description: pad('We are unable to provide visa sponsorship for this role.') })).eligibility, 'VERIFY');
  assert.equal(checkEligibility(atsJob(1, { description: '' })).eligibility, 'VERIFY');
});

test('OK: clean JD', () => {
  assert.equal(checkEligibility(atsJob(1)).eligibility, 'OK');
});

test('salary: structured hourly converts to $K/year', () => {
  assert.deepEqual(parseSalaryK({ salary: { min: 50, max: 60, unit: 'hour' } }, ''), { min: 104, max: 125, text: '' });
});

test('weights are 40/30/15/10/5', () => {
  assert.deepEqual(WEIGHTS, { title: 0.40, skills: 0.30, seniority: 0.15, location: 0.10, salary: 0.05 });
});

test('fit: primary role with strong skill overlap scores ≥ 4; Business Analyst ranks lower', () => {
  const ml = atsJob(1);
  const ba = atsJob(2, { title: 'Business Analyst', description: pad('Gather requirements, write reports in Excel.') });
  const sml = scoreJob(ml, checkEligibility(ml), SKILLS);
  const sba = scoreJob(ba, checkEligibility(ba), SKILLS);
  assert.ok(sml.fit >= 4, `ML fit ${sml.fit}`);
  assert.ok(sba.fit < sml.fit);
  assert.match(sml.why, /CV skills/);
});

test('fit: soft flags (internship, contract) lower the score', () => {
  const base = scoreJob(atsJob(1), checkEligibility(atsJob(1)), SKILLS).fit;
  const intern = atsJob(1, { title: 'Machine Learning Engineer Intern' });
  assert.ok(scoreJob(intern, checkEligibility(intern), SKILLS).fit < base);
});

test('titles map to the archetype tiers', () => {
  assert.equal(titleFit('Senior GenAI Engineer').tier, 'primary');
  assert.equal(titleFit('Data Scientist II').tier, 'primary');
  assert.equal(titleFit('Analytics Engineer').tier, 'secondary');
  assert.equal(titleFit('Business Analyst').tier, 'adjacent');
});

test('CV skills come from the "## Skills" section only', () => {
  const cv = '# Name\n## Summary\nPython wizard\n## Skills\n- **Languages:** Python, SQL, C++\n- **AI / ML:** PyTorch, RAG\n## Education\nMS\n';
  assert.deepEqual(loadCvSkills(cv), ['Python', 'SQL', 'C++', 'PyTorch', 'RAG']);
});

test('GOOD_JD sanity', () => assert.ok(GOOD_JD.length > 200));
