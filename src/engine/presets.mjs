// presets.mjs — named scan presets ("run", "faang", "company Amazon", …).
//
// Presets are CONFIGURATION ONLY: each resolves to config overrides + result
// filters for the one shared runFreshScan() pipeline. No preset has its own
// scanner, and no preset can loosen the strict final gate, freshness rules, or
// cost/time limits — those live in run.mjs / config.mjs LIMITS and are applied
// after any preset.
//
// Defaults live here; config/profile.yml `discovery.presets` adds or overrides
// presets (merged per preset name).

export const DEFAULT_PRESETS = Object.freeze({
  run: {
    description: 'Normal scan: all approved sources',
  },
  faang: {
    description: 'Big tech / AI companies only',
    companies: ['Meta', 'Google', 'Amazon', 'Apple', 'NVIDIA', 'Microsoft'],
  },
  staffing: {
    description: 'Staffing / recruiting firms only',
    companies: ['Experis'],
  },
  startup: {
    description: 'Startup boards: rotating Ashby + Lever boards and tracked companies tagged category: startup',
    category: 'startup',
  },
  remote: {
    description: 'Normal scan, Remote (US) jobs only',
    location: 'remote',
  },
  local: {
    description: 'CT / NY / NJ / MA, plus US-remote',
    locations: ['Connecticut', 'New York', 'New Jersey', 'Massachusetts'],
    includeRemote: true,
  },
});

// Official boards for companies job-radar can read directly. Matched by
// company name; anything here is scanned with the normal provider modules.
// Add more in config/profile.yml under discovery.companyBoards.
export const DEFAULT_COMPANY_BOARDS = Object.freeze({
  Amazon: [
    { name: 'Amazon', careers_url: 'https://www.amazon.jobs', provider: 'amazon', amazon: { base_query: 'machine learning', normalized_country_code: ['USA'] } },
    { name: 'Amazon', careers_url: 'https://www.amazon.jobs', provider: 'amazon', amazon: { base_query: 'data scientist', normalized_country_code: ['USA'] } },
    { name: 'Amazon', careers_url: 'https://www.amazon.jobs', provider: 'amazon', amazon: { base_query: 'data engineer', normalized_country_code: ['USA'] } },
  ],
});

export const PRESET_NAMES = () => Object.keys(DEFAULT_PRESETS);

/**
 * Parse what the user typed: "faang", "company Capital One", "run --no-apify".
 * @returns {{ name: string, arg: string }}
 */
export function parseCommand(words) {
  const w = (Array.isArray(words) ? words : String(words || '').split(/\s+/)).filter(Boolean);
  const first = (w[0] || 'run').toLowerCase();
  if (first === 'company') return { name: 'company', arg: w.slice(1).join(' ').trim() };
  return { name: first, arg: w.slice(1).join(' ').trim() };
}

/**
 * Resolve a command to { overrides, filters } for runFreshScan.
 *   overrides  deep-merged into the discovery config (then clamped by LIMITS)
 *   filters    { companies?, location?: 'remote'|'local', locations?, includeRemote?, category? }
 */
export function resolvePreset(command, presets = DEFAULT_PRESETS) {
  const { name, arg } = typeof command === 'string' ? parseCommand(command) : command;
  if (name === 'company') {
    if (!arg) throw new Error('usage: company <name>   e.g. company Amazon');
    return companyPreset([arg], `company ${arg}`);
  }
  const p = presets[name];
  if (!p) throw new Error(`unknown preset "${name}". Known: ${[...Object.keys(presets), 'company <name>'].join(', ')}`);

  if (Array.isArray(p.companies) && p.companies.length) return companyPreset(p.companies, name, p);

  if (p.category === 'startup') {
    return {
      name,
      description: p.description,
      overrides: {
        sources: { tracked: true, 'ats-rotation': true, apify: false, 'company-boards': false },
        rotationAts: ['ashby', 'lever'],
        trackedCategory: 'startup',
        ...(p.overrides || {}),
      },
      filters: { category: 'startup' },
    };
  }

  const filters = {};
  if (p.location === 'remote') filters.location = 'remote';
  if (Array.isArray(p.locations) && p.locations.length) {
    filters.location = 'local';
    filters.locations = p.locations;
    filters.includeRemote = p.includeRemote !== false;
  }
  return { name, description: p.description, overrides: { ...(p.overrides || {}) }, filters };
}

// Company-scoped scan: the companies' official boards (company-boards source)
// + LinkedIn as a discovery hint restricted to those companies. Indeed has no
// company filter, so it stays off (it would spend money on other employers).
function companyPreset(companies, name, p = {}) {
  return {
    name,
    description: p.description || `Only ${companies.join(', ')}`,
    overrides: {
      sources: { tracked: false, 'ats-rotation': false, apify: true, 'company-boards': true },
      apify: { actors: { indeed: { enabled: false } }, companyNames: companies },
      ...(p.overrides || {}),
    },
    filters: { companies },
  };
}
