// profile.mjs: the candidate-specific part of the pipeline, read from
// config/profile.yml. Everything that differs between two job seekers lives
// here: target roles, skills, preferred locations, salary expectations and
// eligibility (visa / citizenship / experience) rules.
//
// normalizeProfile() fills every missing field with a default, so an empty or
// partial profile.yml is always valid. The defaults describe an early-career
// AI/ML/data candidate on F-1 OPT who will need sponsorship later.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Title tiers, checked in order; the first match wins. `score` is the title
// part of the fit score (0-5). Keywords are case-insensitive phrases matched
// on word boundaries; a keyword wrapped in /slashes/ is used as a regex.
export const DEFAULT_ROLES = Object.freeze([
  { label: 'AI/GenAI Eng', tier: 'primary', score: 5, keywords: ['ai engineer', 'ai/ml', 'ml/ai', 'genai', 'gen ai', 'generative ai', 'llm', 'agentic', 'applied ai', 'ai developer', 'ai software engineer', 'prompt engineer'] },
  { label: 'ML Eng', tier: 'primary', score: 5, keywords: ['machine learning', 'ml engineer', 'mlops', 'ml ops', 'nlp engineer', 'deep learning', 'computer vision engineer', 'ml scientist'] },
  { label: 'Data Scientist', tier: 'primary', score: 5, keywords: ['/data scien\\w*/', '/applied scien\\w*/', '/decision scien\\w*/', 'research scientist'] },
  { label: 'Data Eng', tier: 'secondary', score: 4, keywords: ['/data engineer\\w*/', 'analytics engineer', 'etl', 'data platform engineer', 'data pipeline'] },
  { label: 'Data/BI Analyst', tier: 'secondary', score: 4, keywords: ['data analyst', 'bi analyst', 'business intelligence', 'bi developer', 'bi engineer', 'power bi', 'product analyst', 'analytics analyst', 'reporting analyst', 'data analytics'] },
  { label: 'Business Analyst', tier: 'adjacent', score: 3, keywords: ['business analyst', 'business systems analyst', 'systems analyst'] },
  { label: 'AI-adjacent', tier: 'adjacent', score: 3, keywords: ['ai', 'ml', 'analytics'] },
]);

export const DEFAULT_PREFERRED_LOCATIONS = Object.freeze([
  'connecticut', 'ct', 'new york', 'ny', 'nyc', 'new jersey', 'nj', 'boston', 'massachusetts', 'ma', 'cambridge',
  'stamford', 'hartford', 'new haven', 'west haven', 'jersey city', 'newark', 'hoboken', 'princeton',
]);

export const DEFAULT_ELIGIBILITY = Object.freeze({
  needsSponsorship: true,      // block "no sponsorship now or in the future"; VERIFY vaguer wording
  onOpt: true,                 // block postings that exclude OPT / CPT
  usCitizen: false,            // true skips every citizenship and clearance rule
  graduated: true,             // block postings that require current enrollment
  graduation: '2026-05',       // block postings that require a LATER graduation date
  maxYearsRequired: 5,         // block postings asking for more years than this
  salaryFloorK: 70,            // block postings whose stated maximum is below this ($K/year)
  blockLocalOnly: true,        // block "local candidates only" / "no relocation"
  excludedTitleWords: ['staff', 'principal', 'director', 'head of', 'vice president', 'vp', 'manager', 'distinguished', 'fellow'],
});

export const DEFAULT_SALARY = Object.freeze({ goodK: 110, fairK: 90 });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One keyword list → one case-insensitive regex with word boundaries.
export function keywordRegex(keywords) {
  const parts = (keywords || []).map((k) => String(k).trim()).filter(Boolean).map((k) => {
    const m = k.match(/^\/(.+)\/$/);
    return m ? m[1] : esc(k);
  });
  if (!parts.length) return /(?!)/; // matches nothing
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

// "Graduating in December 2026 or later" style requirements that a candidate
// graduating in `graduation` (YYYY-MM) cannot meet: every later month and
// season of the same year, and the next two years.
export function graduationBlockRegex(graduation) {
  const m = String(graduation || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const later = [];
  for (let i = month; i < 12; i++) {
    later.push(`${MONTHS[i]} ${year}`, `${MONTHS[i].slice(0, 3)}\\.? ${year}`);
  }
  const seasons = [['spring', 5], ['summer', 8], ['fall', 12], ['autumn', 12], ['winter', 12]];
  for (const [season, endMonth] of seasons) if (endMonth > month) later.push(`${season} ${year}`);
  later.push(String(year + 1), String(year + 2));
  return new RegExp(`graduat\\w*[^.]{0,80}(${later.join('|')})`, 'i');
}

function list(v, fallback) {
  return Array.isArray(v) && v.length ? v.map(String) : [...fallback];
}

/**
 * profile.yml (parsed) → normalized profile used by eligibility and scoring.
 * Unknown keys are ignored; missing keys take the defaults above.
 */
export function normalizeProfile(raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const e = p.eligibility || {};
  const pick = (key, snake) => (e[key] ?? e[snake]);
  const eligibility = {
    needsSponsorship: pick('needsSponsorship', 'needs_sponsorship') ?? DEFAULT_ELIGIBILITY.needsSponsorship,
    onOpt: pick('onOpt', 'on_opt') ?? DEFAULT_ELIGIBILITY.onOpt,
    usCitizen: pick('usCitizen', 'us_citizen') ?? DEFAULT_ELIGIBILITY.usCitizen,
    graduated: pick('graduated', 'graduated') ?? DEFAULT_ELIGIBILITY.graduated,
    graduation: pick('graduation', 'graduation') ?? DEFAULT_ELIGIBILITY.graduation,
    maxYearsRequired: Number(pick('maxYearsRequired', 'max_years_required') ?? DEFAULT_ELIGIBILITY.maxYearsRequired),
    salaryFloorK: Number(pick('salaryFloorK', 'salary_floor_k') ?? DEFAULT_ELIGIBILITY.salaryFloorK),
    blockLocalOnly: pick('blockLocalOnly', 'block_local_only') ?? DEFAULT_ELIGIBILITY.blockLocalOnly,
    excludedTitleWords: list(pick('excludedTitleWords', 'excluded_title_words'), DEFAULT_ELIGIBILITY.excludedTitleWords),
  };
  const roles = (Array.isArray(p.roles) && p.roles.length ? p.roles : DEFAULT_ROLES).map((r) => ({
    label: String(r.label || r.name || 'role'),
    tier: ['primary', 'secondary', 'adjacent'].includes(r.tier) ? r.tier : 'primary',
    score: Number.isFinite(Number(r.score)) ? Number(r.score) : ({ primary: 5, secondary: 4, adjacent: 3 }[r.tier] ?? 5),
    re: keywordRegex(r.keywords),
  }));
  const loc = p.locations || {};
  const sal = p.salary || {};
  return {
    roles,
    skills: Array.isArray(p.skills) ? p.skills.map(String).filter(Boolean) : null, // null → read cv.md
    preferredLocations: keywordRegex(list(loc.preferred, DEFAULT_PREFERRED_LOCATIONS)),
    salary: {
      goodK: Number(sal.good_k ?? sal.goodK ?? DEFAULT_SALARY.goodK),
      fairK: Number(sal.fair_k ?? sal.fairK ?? DEFAULT_SALARY.fairK),
    },
    eligibility,
    graduationBlock: graduationBlockRegex(eligibility.graduation),
    excludedTitle: keywordRegex(eligibility.excludedTitleWords),
  };
}

export const DEFAULT_PROFILE = normalizeProfile({});
