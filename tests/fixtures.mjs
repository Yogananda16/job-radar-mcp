// Fixtures shaped exactly like the 2026-10-11 Apify probe output and the
// Workday CXS / SmartRecruiters Posting API documents career-ops' providers
// already parse. Values are synthetic.
import { NOW, HOUR, DAY } from './helpers.mjs';

const iso = (ms) => new Date(ms).toISOString();
const isoDay = (ms) => iso(ms).slice(0, 10);

export const LINKEDIN_ITEM = {
  id: '4460000001',
  url: 'https://www.linkedin.com/jobs/view/data-scientist-at-initech-4460000001',
  title: 'Data Scientist',
  companyName: 'Initech',
  companyUrl: 'https://www.linkedin.com/company/initech',
  location: 'New York, NY',
  postedDate: `${isoDay(NOW)}T00:00:00.000Z`,
  postedTimeAgo: '3 hours ago',
  applyType: 'EXTERNAL',
  applyUrl: '',
  salary: '$240,000.00/yr - $300,000.00/yr',
  workType: 'Software Development',
  contractType: 'Full-time',
  experienceLevel: 'Mid-Senior level',
  description: 'Build ML models in Python and SQL. '.repeat(20),
};

const indeedBase = {
  url: 'https://www.indeed.com/viewjob?jk=KEY',
  datePublished: iso(NOW - 5 * HOUR),
  dateOnIndeed: iso(NOW - 4 * HOUR),
  isRepost: null,
  isLatestPost: null,
  expired: false,
  parentEmployer: { name: '', companyPageUrl: '' },
  location: { countryName: 'United States', countryCode: 'US', admin1Code: 'CA', city: 'Orange', postalCode: '92868' },
  baseSalary: { min: 120000, max: 150000, unitOfWork: 'YEAR', currencyCode: 'USD' },
  description: { text: 'Machine learning with Python, SQL and PyTorch. '.repeat(20), html: '<p>…</p>' },
  attributes: {},
};

export const INDEED_WORKDAY = {
  ...indeedBase, key: 'aaaa000000000001', refNum: 'JOB_POSTING-3-5867', title: 'Senior Data Scientist',
  url: 'https://www.indeed.com/viewjob?jk=aaaa000000000001',
  jobUrl: 'https://umbrella.wd12.myworkdayjobs.com/umbrella_external/job/Anywhere-in-the-US/Senior-Data-Scientist_R2690',
  employer: { name: 'Umbrella Health', companyPageUrl: 'https://www.indeed.com/cmp/Umbrella', corporateWebsite: 'http://www.umbrella.example' },
};

export const INDEED_SMARTRECRUITERS = {
  ...indeedBase, key: 'aaaa000000000002', refNum: 'f1d49ce6-dcef-4b96-ae83-466771b665be', title: 'Machine Learning Engineer',
  url: 'https://www.indeed.com/viewjob?jk=aaaa000000000002',
  jobUrl: 'https://jobs.smartrecruiters.com/HOOLI/744000154887278-machine-learning-engineer',
  employer: { name: 'Hooli', companyPageUrl: '' },
};

export const INDEED_HIDDEN_EMPLOYER = {
  ...indeedBase, key: 'aaaa000000000003', refNum: '4f693ba0-aae9-4e14-bda9-1ca11f5feb7b', title: 'AI Engineering Lead',
  url: 'https://www.indeed.com/viewjob?jk=aaaa000000000003',
  jobUrl: 'http://www.indeed.com/job/ai-engineering-lead-aaaa000000000003',
  employer: { name: null, companyPageUrl: '' },
  description: { text: 'Join Hooli-like startup building agents with Python and RAG. '.repeat(10), html: '' },
};

export const INDEED_HTTP_EMPLOYER = {
  ...INDEED_WORKDAY, key: 'aaaa000000000004',
  jobUrl: 'http://careers.vandelay.example/jobs/123',
  employer: { name: 'Vandelay Industries' },
};

// Apify run record after the probe (pay-per-event).
export function apifyRunRecord({ items = 5, itemPrice = 0.0004, startPrice = 0.001, withCharges = true } = {}) {
  return {
    id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: withCharges ? items * itemPrice + startPrice : undefined,
    ...(withCharges ? {
      chargedEventCounts: { 'apify-default-dataset-item': items, 'apify-actor-start': 1 },
      pricingInfo: { pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
        'apify-default-dataset-item': { eventPriceUsd: itemPrice },
        'apify-actor-start': { eventPriceUsd: startPrice },
      } } },
    } : {}),
  };
}

// Workday CXS detail document (GET {cxsBase}{externalPath}).
export function workdayDetail({ startDate = isoDay(NOW), title = 'Senior Data Scientist', canApply = true } = {}) {
  return {
    jobPostingInfo: {
      id: 'abc', title, jobDescription: '<p>Senior Data Scientist working on ML with Python and SQL.</p>'.repeat(5),
      location: 'Anywhere in the US', postedOn: 'Posted Today', startDate, timeType: 'Full time',
      jobReqId: 'R2690', canApply,
      externalUrl: 'https://umbrella.wd12.myworkdayjobs.com/umbrella_external/job/Anywhere-in-the-US/Senior-Data-Scientist_R2690',
    },
    hiringOrganization: { name: 'Umbrella Health' },
  };
}

// SmartRecruiters Posting API detail (GET /v1/companies/{slug}/postings/{id}).
export function srDetail({ releasedDate = iso(NOW - 2 * HOUR), active = true, refNumber = 'REF-7781', name = 'Machine Learning Engineer' } = {}) {
  return {
    id: '744000154887278', name, refNumber, releasedDate, active,
    company: { identifier: 'HOOLI', name: 'Hooli' },
    location: { city: 'Washington', region: 'DC', country: 'us' },
    jobAd: { sections: {
      jobDescription: { title: 'Job Description', text: '<p>Build ML systems with Python and PyTorch.</p>'.repeat(5) },
      qualifications: { title: 'Qualifications', text: '<p>2+ years of experience.</p>' },
    } },
  };
}

export { DAY };
