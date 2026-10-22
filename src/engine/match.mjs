// match.mjs — shared "is this the same employer / the same role?" helpers.
import { companyKey, normKey } from './job.mjs';

export const compactCompany = (s) => companyKey(s).replace(/ /g, '');

// Employer names match: same letters/digits after dropping Inc/LLC/…, or one
// name's ≥2 words all appear (or prefix a word) in the other —
// "JPMorgan Chase" ≈ "JPMorganChase", "Alignment Health" ≈ "Alignment Healthcare".
export function employerMatches(company, orgName) {
  const a = compactCompany(company); const b = compactCompany(orgName);
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = companyKey(company).split(' ').filter((w) => w.length > 1);
  const tb = companyKey(orgName).split(' ').filter((w) => w.length > 1);
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.length >= 2 && small.every((w) => big.some((x) => x === w || x.startsWith(w)));
}

// Seniority/level words must agree: "Data Scientist" ≠ "Senior Data Scientist",
// "Engineer II" ≠ "Engineer III".
const LEVEL_MAP = { sr: 'senior', senior: 'senior', jr: 'junior', junior: 'junior', lead: 'lead', principal: 'principal',
  staff: 'staff', intern: 'intern', internship: 'intern', associate: 'associate', manager: 'manager', director: 'director',
  head: 'head', i: 'l1', ii: 'l2', iii: 'l3', iv: 'l4', v: 'l5', '1': 'l1', '2': 'l2', '3': 'l3', '4': 'l4', '5': 'l5' };
export function levelSignature(title) {
  const words = normKey(String(title || '').replace(/\([^)]*\)/g, ' ')).split(' ');
  return [...new Set(words.map((w) => LEVEL_MAP[w]).filter(Boolean))].sort().join(',');
}
