// sources/apify-indeed.mjs — adapter for valig/indeed-jobs-scraper.
// Input fields per the actor's published schema: country ("us"), title,
// location, limit, datePosted. Probe 2026-10-11 (5 items): datePosted "1"
// returned only postings from the last ~19h — consistent with "last 24h";
// the scan still enforces 24h itself.
//
// Output, as observed in the probe:
//   key (stable id) · refNum (employer requisition no.) · url (Indeed page) ·
//   jobUrl (employer link — or an http://www.indeed.com/job/… page for
//   Indeed-hosted jobs) · employer{name|null} · location{city, admin1Code,
//   countryCode} · datePublished (sometimes day-only, e.g. 05:00Z) ·
//   dateOnIndeed (index time) · baseSalary{min,max,unitOfWork} ·
//   description{text,html} · isRepost / isLatestPost (present, null in the probe)
// Indeed dates are aggregator evidence, never proof of the original posting.
import { makeJob, EVIDENCE, isEmployerUrl, upgradeHttp } from '../job.mjs';
import { pick } from './apify-util.mjs';

function locationText(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  return loc.formatted?.long || loc.formatted?.short || loc.fullAddress
    || [loc.city, loc.admin1Code || loc.state, loc.countryCode].filter(Boolean).join(', ');
}

// Employer name exactly as Indeed gives it; null/empty stays '' — never
// inferred from the description, URL or anywhere else.
function employerName(item) {
  const e = item.employer;
  const name = e && typeof e === 'object' ? e.name : e;
  return typeof name === 'string' ? name.trim() : (pick(item, ['companyName', 'company']) || '');
}

export const indeedAdapter = {
  id: 'apify-indeed',
  actorDefault: 'valig/indeed-jobs-scraper',
  // location (optional, documented input: "City, state, zip code, or remote") —
  // set by location presets such as `ct`.
  buildInput(query, { limit, datePosted = '1', country = 'us', location = '' }) {
    const input = { country, title: query, limit, datePosted };
    if (location) input.location = location;
    return input;
  },
  mapItem(item, now) {
    const base = item.baseSalary || item.salary;
    const jobUrl = upgradeHttp(pick(item, ['jobUrl', 'externalApplyLink', 'applyUrl']));
    const desc = item.description && typeof item.description === 'object' ? item.description.text : pick(item, ['description', 'descriptionText']);
    const remote = /\bremote\b/i.test(locationText(item.location)) || Boolean(item.isRemote || item.remote);
    void now;
    return makeJob({
      source: 'apify-indeed',
      sourceJobId: pick(item, ['key', 'jobKey', 'id']),
      requisitionId: pick(item, ['refNum', 'requisitionId']) || '',
      sourceRepost: item.isRepost === true,
      url: pick(item, ['url', 'viewJobLink']),
      employerUrl: jobUrl && isEmployerUrl(jobUrl) ? jobUrl : '',
      company: employerName(item),
      title: pick(item, ['title', 'positionName']),
      location: locationText(item.location),
      postedAt: pick(item, ['datePublished', 'dateOnIndeed', 'postedAt']) ?? null,
      postedEvidence: EVIDENCE.AGGREGATOR,
      description: desc || '',
      salary: base && typeof base === 'object' && (base.min || base.max)
        ? { min: base.min, max: base.max, unit: String(base.unitOfWork || base.unit || 'year').toLowerCase(), text: '' }
        : null,
      remote,
    });
  },
};
