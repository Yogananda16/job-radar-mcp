// eligibility.mjs — deterministic eligibility gate. The rules that apply come
// from the candidate profile (config/profile.yml → eligibility). A gate, not points:
//   BLOCKED  clear hard disqualifier (quoted) — never enters the Top 10
//   VERIFY   ambiguous wording, or no job text to check
//   OK       nothing found
// Soft flags (internship, contract, senior+5y) only lower the fit score.

import { DEFAULT_PROFILE } from './profile.mjs';

// Each rule: [regex, reason, group]. A group is switched off by the profile:
//   sponsorship  eligibility.needsSponsorship = false
//   citizenship  eligibility.usCitizen = true
//   enrollment   eligibility.graduated = false
//   opt          eligibility.onOpt = false
//   local        eligibility.blockLocalOnly = false
const BLOCK = [
  [/(sponsor\w*|immigration)[^.]{0,120}now or in the future/i, 'no sponsorship now or in the future', 'sponsorship'],
  [/now or in the future[^.]{0,120}(sponsor\w*|immigration)/i, 'no sponsorship now or in the future', 'sponsorship'],
  [/(will not|won't|do not|does not|cannot|unable to)[^.]{0,40}(ever |in the future )?(require|need)[^.]{0,30}sponsor\w*/i, 'must never require sponsorship', 'sponsorship'],
  [/(u\.?s\.?|united states) citizens? (only|required)/i, 'US citizens only', 'citizenship'],
  [/must be an? (u\.?s\.?|united states) citizen/i, 'US citizen required', 'citizenship'],
  [/(u\.?s\.?|united states) citizenship (is )?required/i, 'US citizenship required', 'citizenship'],
  // "United States Citizenship (essential to comply with government contract requirements)"
  [/(u\.?s\.?|united states) citizenship\s*[(:,–-]?\s*(is\s+)?(essential|mandatory|a must|needed|necessary|required)/i, 'US citizenship required', 'citizenship'],
  [/green card holders? only|permanent residents? only/i, 'Green Card / PR only', 'citizenship'],
  [/(u\.?s\.? )?citizens? or (green card|permanent resident)s?( holders?)? only/i, 'US citizen or Green Card only', 'citizenship'],
  // Clearance is a hard stop ONLY when US citizenship is explicitly required for
  // it (eligibility.usCitizen = false). Clearance with citizenship unstated → VERIFY below.
  [/clearance[^.]{0,80}\b(requires?|required|requiring|must (be|have))\b[^.]{0,40}\b(u\.?s\.?|united states) citizen(ship)?/i, 'clearance requiring US citizenship', 'citizenship'],
  [/(u\.?s\.?|united states) citizen(ship)?[^.]{0,60}\b(required|needed|necessary|eligib\w*)\b[^.]{0,40}clearance/i, 'clearance requiring US citizenship', 'citizenship'],
  [/(currently enrolled|must be enrolled|currently pursuing|returning to (school|your studies))/i, 'current enrollment required', 'enrollment'],
  [/(not eligible|cannot accept|unable to accept|do not accept|does not accept)[^.]{0,40}\b(opt|cpt|stem opt)\b/i, 'excludes OPT / STEM OPT', 'opt'],
  [/\bPERM\b|labor certification/i, 'PERM / labor certification wording', 'always'],
  [/local candidates only|must (currently )?reside (locally|in the area)|relocation (is )?not (permitted|allowed|considered)/i, 'local candidates only / no relocation', 'local'],
];

const VERIFY = [
  [/(no|not|unable to|cannot|do not|does not|will not|won't)[^.]{0,30}(provide |offer |support )?(work )?(visa |immigration )?sponsor\w*/i, 'sponsorship wording', 'sponsorship'],
  [/sponsorship (is )?not (available|offered|provided)/i, 'sponsorship not available', 'sponsorship'],
  // Profile rule: "Clearance required, citizenship requirement unstated → VERIFY".
  [/(ts\/sci|top secret|secret clearance|security clearance|government clearance|federal clearance|\bclearance\b)[^.]{0,80}(required|is required|must|mandatory)/i, 'clearance required (citizenship unstated)', 'citizenship'],
  [/(active|current)[^.]{0,30}(secret|ts\/sci|top secret|clearance)/i, 'active clearance required (citizenship unstated)', 'citizenship'],
  // Not the "Employee Polygraph Protection Act" legal-notice footer (EEO boilerplate).
  [/\bpolygraph\b(?!\s+protection)/i, 'polygraph mentioned (citizenship unstated)', 'citizenship'],
  [/public trust/i, 'public trust clearance', 'citizenship'],
  [/(ability|able|eligib\w*) to (obtain|get|acquire|hold|maintain)[^.]{0,40}clearance/i, 'ability to obtain clearance', 'citizenship'],
  [/\b(clearance)\b/i, 'clearance mentioned', 'citizenship'],
  [/authori[sz]ed to work in the (u\.?s\.?|united states)[^.]{0,60}without/i, 'work-authorization wording', 'sponsorship'],
];

const YEARS = /(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*\+?\s*(?:or more\s+)?years?['’]?\s*(?:of\s+)?[^.]{0,60}?experience/gi;
// "$120,000 - $150,000", "$120K–$150K", "$240,000.00/yr - $300,000.00/yr", "$50/hr - $60/hr".
const AMT = String.raw`\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?\s?[kK]\b|\d+(?:\.\d{1,2})?)`;
const PER = String.raw`(?:\s*(?:\/|per)\s*(yr|year|annum|annually|hr|hour|hourly))?`;
const SALARY = new RegExp(`${AMT}${PER}(?:\\s*(?:-|–|—|to)\\s*${AMT}${PER})?`, 'i');
const SCOPE_TITLE = /\b(staff|principal|director|head of|vice president|vp|manager|distinguished|fellow)\b/i;

function quote(re, text) {
  const m = text.match(re);
  if (!m) return null;
  const i = Math.max(0, m.index - 40);
  return text.slice(i, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
}

// One matched amount → $K/year. Bare small numbers count only when marked hourly.
function kValue(amount, per) {
  if (!amount) return null;
  const t = String(amount).replace(/,/g, '').trim();
  const k = t.match(/^(\d+(?:\.\d+)?)\s?[kK]$/);
  if (k) return Math.round(Number(k[1]));
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (/^(hr|hour|hourly)$/i.test(per || '')) return Math.round((n * 2080) / 1000);
  return n >= 1000 ? Math.round(n / 1000) : null;
}

// Salary in $K/year. Source-provided structured salary wins over text.
export function parseSalaryK(job, text) {
  const s = job.salary;
  if (s && (s.min || s.max)) {
    const per = String(s.unit || s.period || 'year').toLowerCase();
    const perYear = /hour/.test(per) ? 2080 : /week/.test(per) ? 52 : /month/.test(per) ? 12 : 1;
    const toK = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round((Number(v) * perYear) / 1000));
    return { min: toK(s.min), max: toK(s.max ?? s.min), text: s.text || '' };
  }
  const all = new RegExp(SALARY.source, 'gi');
  for (const src of [String(s?.text || ''), String(text || '')]) {
    for (const m of src.matchAll(all)) {
      // "$50 - $60/hr": the unit written once at the end applies to both ends.
      const min = kValue(m[1], m[2] || m[4]);
      const max = kValue(m[3], m[4] || m[2]) ?? min;
      if (min && min >= 20 && max >= min) return { min, max, text: m[0].trim() }; // skips "$1,000 bonus"-style noise
    }
  }
  return null;
}

export function yearsAsked(text) {
  const yrs = [...String(text || '').matchAll(YEARS)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 15);
  return yrs.length ? Math.min(...yrs) : null;
}

function ruleOn(group, e) {
  if (group === 'sponsorship') return e.needsSponsorship;
  if (group === 'citizenship') return !e.usCitizen;
  if (group === 'enrollment') return e.graduated;
  if (group === 'opt') return e.onOpt;
  if (group === 'local') return e.blockLocalOnly;
  return true;
}

/**
 * @param {object} job      normalized job (title, description, salary)
 * @param {object} profile  normalizeProfile() result; defaults when omitted
 */
export function checkEligibility(job, profile = DEFAULT_PROFILE) {
  const e = profile.eligibility;
  const text = job.description || '';
  const hasText = text.length >= 200;
  const blocked = [];
  const verify = [];
  const soft = [];

  if (profile.excludedTitle.test(job.title)) blocked.push({ reason: 'Staff/Principal/Manager-level scope', quote: job.title });

  if (hasText) {
    for (const [re, reason, group] of BLOCK) {
      if (!ruleOn(group, e)) continue;
      const q = quote(re, text); if (q) blocked.push({ reason, quote: q });
    }
    if (profile.graduationBlock) {
      const q = quote(profile.graduationBlock, text);
      if (q) blocked.push({ reason: `graduation window excludes ${e.graduation}`, quote: q });
    }
    if (!blocked.some((b) => /sponsor/.test(b.reason))) {
      for (const [re, reason, group] of VERIFY) {
        if (!ruleOn(group, e)) continue;
        const q = quote(re, text); if (q) verify.push({ reason, quote: q });
      }
    }
  } else {
    verify.push({ reason: 'no job text available to check eligibility', quote: '' });
  }

  const yearsMin = hasText ? yearsAsked(text) : null;
  if (yearsMin != null && yearsMin > e.maxYearsRequired) blocked.push({ reason: `requires ${yearsMin}+ years`, quote: '' });

  const salary = parseSalaryK(job, text);
  if (salary?.max && salary.max < e.salaryFloorK) blocked.push({ reason: `stated base ceiling $${salary.max}K < $${e.salaryFloorK}K`, quote: salary.text || '' });

  if (/\bintern(ship)?\b/i.test(job.title)) soft.push('internship');
  if (/\b(contract|contractor|c2c|1099|temporary|temp)\b/i.test(job.title) || /\b(c2c|corp[- ]to[- ]corp|1099)\b/i.test(text)) soft.push('contract');
  if (/\b(senior|sr\.?)\b/i.test(job.title) && yearsMin != null && yearsMin >= 5) soft.push('senior 5+ yrs');

  const eligibility = blocked.length ? 'BLOCKED' : verify.length ? 'VERIFY' : 'OK';
  return { eligibility, blocked, verify, soft, yearsMin, salary, hasText };
}
