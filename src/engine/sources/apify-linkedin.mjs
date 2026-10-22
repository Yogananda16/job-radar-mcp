// sources/apify-linkedin.mjs — adapter for valig/linkedin-jobs-scraper.
// Input fields per the actor's published schema (checked 2026-10-11):
//   keywords, location, datePosted ("r86400" = past 24 hours), limit (≤1000),
//   skipJobId (array), titleExclude (array).
// LinkedIn's displayed time can be a refresh — mapped as aggregator evidence,
// never as proof of an original posting time.
import { makeJob, EVIDENCE, isEmployerUrl, upgradeHttp } from '../job.mjs';
import { parseRelativeAge, pick } from './apify-util.mjs';

export const linkedinAdapter = {
  id: 'apify-linkedin',
  actorDefault: 'valig/linkedin-jobs-scraper',
  // companyNames: the actor's documented `companyName` (array) filter — used by
  // company presets so LinkedIn only returns those employers (discovery hints).
  buildInput(query, { limit, skipIds = [], titleExclude = [], location = 'United States', companyNames = [] }) {
    const input = { keywords: query, location, datePosted: 'r86400', limit };
    if (skipIds.length) input.skipJobId = skipIds;
    if (titleExclude.length) input.titleExclude = titleExclude;
    if (companyNames.length) input.companyName = companyNames;
    return input;
  },
  // Probe 2026-10-11: `postedDate` is day-only (always T00:00:00Z) and
  // `applyUrl` was empty for every EXTERNAL job — employer confirmation has to
  // come from the company lookup in ats.mjs.
  mapItem(item, now) {
    const listed = parseRelativeAge(pick(item, ['postedTimeAgo']), now) ?? pick(item, ['postedDate', 'postedAt', 'listedAt']);
    const apply = upgradeHttp(pick(item, ['applyUrl', 'externalApplyUrl', 'companyApplyUrl']));
    const salaryText = pick(item, ['salary']);
    return makeJob({
      source: 'apify-linkedin',
      sourceJobId: pick(item, ['id', 'jobId']),
      url: pick(item, ['url', 'jobUrl', 'link']),
      employerUrl: apply && isEmployerUrl(apply) ? apply : '',
      company: pick(item, ['companyName', 'company']),
      title: pick(item, ['title', 'jobTitle']),
      location: pick(item, ['location']),
      postedAt: listed,
      postedEvidence: EVIDENCE.AGGREGATOR,
      description: pick(item, ['description', 'descriptionText']),
      salary: typeof salaryText === 'string' && salaryText ? { text: salaryText } : null,
      // `workType` is the INDUSTRY ("Software Development"), not remote/onsite
      // (probe 2026-10-11) — remote comes from the location text only.
      remote: /\bremote\b/i.test(String(pick(item, ['location']) || '')),
    });
  },
};
