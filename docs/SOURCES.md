# Sources

Where job-radar finds jobs, how each source is read, and what it can and can't prove. Sources fall into two roles:

| Role | Can prove a job is fresh and live? | Examples |
|---|---|---|
| **Employer systems** (source of truth) | Yes | Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle, iCIMS, amazon.jobs |
| **Discovery** (leads only) | No; each lead must be confirmed at the employer | LinkedIn, Indeed, RemoteOK, Remotive, The Muse, HN "Who is hiring", … |

## Scan sources (workers)

| Source | What it scans | Default | Cost |
|---|---|---|---|
| `tracked` | Every enabled company in `config/portals.yml`, plus the free public boards | on | $0 |
| `ats-rotation` | A rotating batch (25 by default) of ~9,000 public Greenhouse/Lever/Ashby boards | on | $0 |
| `apify` | LinkedIn + Indeed searches for your queries, past 24 h | on when `APIFY_TOKEN` is set | ≤ $0.10/scan |
| `company-boards` | Official boards of named companies (company presets) | off; presets turn it on | $0 |

At most 3 run at once (see [GUARDRAILS.md](GUARDRAILS.md)).

### Rotation

The rotation walks the public lists from [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator), a different slice each scan. The cursor lives in `state/discovery-state.json`, so 24 hourly scans × 25 boards cover about 600 boards a day, and the full list over about two weeks.

- Boards that fail mid-scan are retried first next time.
- Boards that return HTTP 404 three times are skipped for 30 days.
- Boards you already track are excluded, so nothing is scanned twice.
- The lists are cached for 24 hours in `state/cache/`.

## Employer systems

| ATS | How it's read | Freshness evidence | Notes |
|---|---|---|---|
| **Greenhouse** | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | `first_published` (exact) | Most common for tech companies |
| **Lever** | `api.lever.co/v0/postings/{slug}` | `createdAt` (exact) | |
| **Ashby** | `api.ashbyhq.com/posting-api/job-board/{slug}` | `publishedAt` (exact) | Common for startups |
| **SmartRecruiters** | public postings API | `releasedDate` (exact) | Requisition number joins identity |
| **Workday** | CXS JSON API (`/wday/cxs/{tenant}/{site}/jobs`) | `startDate` (**day only**) | NEW only if that day is today; posting must be open (`canApply`) |
| **Oracle Recruiting Cloud** | `hcmRestApi` requisition API | ISO posting date | Only for sites listed in `companyBoards` or tracked |
| **iCIMS** | posting page JSON-LD (`JobPosting`) | `datePosted` | Exact tenant match plus `hiringOrganization` check |
| **amazon.jobs** | `search.json` | `posted_date` (day only) | Built in as the Amazon company board |

### Verifying a discovery lead at the employer

When a LinkedIn/Indeed job reaches the shortlist, job-radar tries, in order:

1. **Direct link.** If the lead already points at an employer ATS URL, read that posting.
2. **Greenhouse / Lever / Ashby.** Find the employer's board (a tracked entry, or a board whose own name matches) and match the job by title, seniority and location.
3. **Workday.** Find candidate tenants in the public Workday list (tracked › exact name › prefix › acronym, max 3), search by title, take the single best match, open its posting document, and confirm the employer via `hiringOrganization`.
4. **Oracle, iCIMS.** Configured sites and exact iCIMS tenants only.

A match must pass the employer, title (≥ 0.8 similarity, same seniority words), location and open-posting checks. If two postings match equally well, the lead is rejected as ambiguous. On a confirmed match, the employer's publish date replaces the aggregator's, and the employer URL becomes the apply link. If nothing confirms the lead, it stays VERIFY and is never shown.

## Discovery sources

### Apify: LinkedIn and Indeed

| | LinkedIn | Indeed |
|---|---|---|
| Actor | `valig/linkedin-jobs-scraper` | `valig/indeed-jobs-scraper` |
| 24 h filter | `datePosted: "r86400"` | `datePosted: "1"` |
| Results per query | 15 (≤ 50) | 15 (≤ 50) |
| Useful fields | stable `id`, `postedTimeAgo`, company, location | stable `key`, `refNum` (requisition), employer link when present |
| Price (observed) | $0.001/run + ~$0.0004/result | $0.001/run + ~$0.0001/result |

Queries come from `discovery.apify.queries`, one run per query per actor. Company presets restrict LinkedIn to those employers (`companyName`) and turn Indeed off. Location presets can pass a location input. Cost is read back exactly from each run's charged events (see [COST.md](COST.md)).

LinkedIn/Indeed times are **never** treated as proof of freshness. Jobs with a hidden employer ("Confidential", agency posts) are excluded as `employer hidden`, never guessed.

### Free public boards

The `tracked` worker reads these as discovery-only sources:

- Built In (category pages only, per its robots.txt)
- The Muse
- HN "Who is hiring"
- a16z Speedrun
- Agentic Jobs
- RemoteOK
- Remotive
- Himalayas
- Jobicy
- We Work Remotely
- Working Nomads
- NoDesk
- Jobspresso
- 4dayweek

Turn them off with `discovery.includePublicBoards: false`.

### Deliberately excluded

job-radar does not scan sites that require a login or whose terms prohibit automated access. Examples are Handshake, Meta's careers site, and some staffing agency portals. For those, paste the job text into `check_eligibility` (MCP) or apply directly.

## Adding a source

See [ARCHITECTURE.md § Extending](ARCHITECTURE.md#9-extending-job-radar).
