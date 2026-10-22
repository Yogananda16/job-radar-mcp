// score.mjs — deterministic fit score, 0–5 (no LLM).
// Weights: title 40%, skill overlap 30%,
// seniority/years 15%, location 10%, salary 5%. Soft red flags −0.5 each.
// Target roles, preferred locations and salary bands come from the profile
// (config/profile.yml); see profile.mjs for the defaults.
import fs from 'fs';
import { DEFAULT_PROFILE } from './profile.mjs';

export const WEIGHTS = Object.freeze({ title: 0.40, skills: 0.30, seniority: 0.15, location: 0.10, salary: 0.05 });

export function titleFit(title, profile = DEFAULT_PROFILE) {
  for (const t of profile.roles) if (t.re.test(title)) return t;
  return { tier: 'other', label: 'other', score: 1.5 };
}

// Skills: profile.yml `skills:` when set, otherwise cv.md's "## Skills" section.
export function loadCvSkills(cvText) {
  const m = String(cvText || '').match(/^##\s+Skills\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return [];
  const skills = new Set();
  for (const line of m[1].split(/\r?\n/)) {
    const body = line.replace(/^\s*[-*]\s*(\*\*[^*]+\*\*:?)?/, '').trim();
    for (const raw of body.split(/[,;]/)) {
      const s = raw.replace(/[*_`]/g, '').trim();
      if (s.length >= 2 && s.length <= 40) skills.add(s);
    }
  }
  return [...skills];
}

export function loadCvSkillsFile(cvPath) {
  try { return loadCvSkills(fs.readFileSync(cvPath, 'utf8')); } catch { return []; }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function compileSkills(skills) {
  return skills.map((s) => {
    const core = esc(s).replace(/\\ /g, '[\\s-]?');
    return { skill: s, re: new RegExp(`(^|[^a-z0-9+#])${core}(s)?(?=$|[^a-z0-9+#])`, 'i') };
  });
}

export function skillOverlap(text, compiled) {
  const hits = [];
  for (const { skill, re } of compiled) if (re.test(text)) hits.push(skill);
  return hits;
}

function skillScore(n, hasText) {
  if (!hasText) return 3; // unknown, neutral
  if (n >= 8) return 5;
  if (n >= 6) return 4.5;
  if (n >= 4) return 4;
  if (n >= 2) return 3;
  if (n === 1) return 2;
  return 1.5;
}

function seniorityScore(title, yearsMin) {
  if (yearsMin == null) {
    if (/\b(junior|jr\.?|associate|entry|new grad|graduate|early[- ]career|level 1|\bI\b)\b/i.test(title)) return 5;
    if (/\b(senior|sr\.?|lead)\b/i.test(title)) return 3;
    return 4.25;
  }
  if (yearsMin <= 2) return 5;
  if (yearsMin === 3) return 4.5;
  if (yearsMin === 4) return 4;
  if (yearsMin === 5) return 3;
  return 1.5;
}

function locationScore(job, profile) {
  const L = job.location || '';
  if (job.remote || /\bremote\b/i.test(L)) return { s: 5, label: 'Remote' };
  if (profile.preferredLocations.test(L)) return { s: /\bhybrid\b/i.test(`${L} ${job.description || ''}`) ? 4.5 : 4.25, label: L };
  if (!L) return { s: 3.5, label: 'location n/a' };
  return { s: 3.5, label: L };
}

function salaryScore(salary, profile) {
  const { goodK, fairK } = profile.salary;
  const floorK = profile.eligibility.salaryFloorK;
  if (!salary || !(salary.min || salary.max)) return { s: 3.5, label: '' };
  const v = salary.min || salary.max;
  const label = salary.max && salary.max !== salary.min ? `$${salary.min}K–$${salary.max}K` : `$${v}K`;
  if (v >= goodK) return { s: 5, label };
  if (v >= fairK) return { s: 4.5, label };
  if (v >= floorK) return { s: 3.5, label };
  return { s: 2, label };
}

/**
 * @param {object} job  normalized job
 * @param {object} elig checkEligibility(job) result
 * @param {Array} compiledSkills
 * @param {object} profile  normalizeProfile() result; defaults when omitted
 */
export function scoreJob(job, elig, compiledSkills, profile = DEFAULT_PROFILE) {
  const t = titleFit(job.title, profile);
  const hits = elig.hasText ? skillOverlap(job.description, compiledSkills) : [];
  const parts = {
    title: t.score,
    skills: skillScore(hits.length, elig.hasText),
    seniority: seniorityScore(job.title, elig.yearsMin),
    location: locationScore(job, profile).s,
    salary: salaryScore(elig.salary, profile).s,
  };
  let fit = Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * parts[k], 0);
  fit -= 0.5 * elig.soft.length;
  fit = Math.max(0, Math.min(5, Math.round(fit * 10) / 10));

  const why = [t.label];
  if (elig.hasText) why.push(`${hits.length} CV skill${hits.length === 1 ? '' : 's'}${hits.length ? ` (${hits.slice(0, 4).join(', ')})` : ''}`);
  else why.push('skills unchecked');
  why.push(locationScore(job, profile).label);
  const sal = salaryScore(elig.salary, profile).label;
  if (sal) why.push(sal);
  if (elig.yearsMin != null) why.push(`${elig.yearsMin}+ yrs asked`);
  for (const f of elig.soft) why.push(`⚠ ${f}`);

  // Fit is ambiguous when key inputs are missing.
  const fitConfidence = elig.hasText ? 'normal' : 'low';
  return { fit, parts, tier: t.tier, skillHits: hits, why: why.join(' · '), fitConfidence };
}
