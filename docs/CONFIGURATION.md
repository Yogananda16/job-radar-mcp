# Configuration

job-radar is configured by two YAML files plus environment variables:

| File | Purpose | Template |
|---|---|---|
| `config/profile.yml` | Who you are: roles, skills, locations, salary, eligibility, alerts, AI, scan settings | [`config/profile.example.yml`](../config/profile.example.yml) |
| `config/portals.yml` | Where to look: tracked companies, title filter, location filter | [`config/portals.example.yml`](../config/portals.example.yml) |
| `.env` / GitHub secrets | Credentials | [`.env.example`](../.env.example) |

Optional: `config/cv.md` (a skills source, see [skills](#skills)) and `config/blacklist.md` (companies to never show, see [blacklist](#blacklist)).

Every field is optional. A missing field takes the default shown below, so an empty `profile.yml` is valid. Set `JOB_RADAR_HOME` to keep `config/` and `state/` outside the repository.

- [profile.yml](#profileyml): [candidate](#candidate) · [roles](#roles) · [skills](#skills) · [locations](#locations) · [salary](#salary) · [eligibility](#eligibility) · [alerts](#alerts) · [ai](#ai) · [discovery](#discovery)
- [portals.yml](#portalsyml): [title_filter](#title_filter) · [location_filter](#location_filter) · [tracked_companies](#tracked_companies)
- [Environment variables](#environment-variables)
- [Recipes](#recipes)

---

## profile.yml

### candidate

```yaml
candidate:
  name: "Sam"          # used in the email greeting and the AI prompt
```

### roles

Target role tiers, checked **top to bottom; the first match wins**. The matched tier is the title part (40%) of the fit score. A title that matches no tier scores 1.5/5 on that part, so it ranks low and usually falls below `alerts.email.min_fit`.

```yaml
roles:
  - label: "ML Eng"                 # shown in "Why it matches"
    tier: primary                   # primary = 5 · secondary = 4 · adjacent = 3
    keywords: ["machine learning", "ml engineer", "mlops"]
  - label: "Data Scientist"
    tier: primary
    keywords: ["/data scien\\w*/", "research scientist"]   # /…/ = regular expression
  - label: "Data Analyst"
    tier: secondary
    score: 4.5                      # optional: override the tier's score
    keywords: ["data analyst", "product analyst"]
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `label` | string | `role` | Display name |
| `tier` | `primary` \| `secondary` \| `adjacent` | `primary` | Ranking order and default score |
| `score` | number 0–5 | by tier | Title score for this tier |
| `keywords` | list | — | Case-insensitive, whole-word phrases. Wrap in `/…/` for a regex (escape `\` as `\\` in YAML) |

Default: AI/GenAI Engineer, ML Engineer, Data Scientist (primary); Data Engineer, Data/BI Analyst (secondary); Business Analyst, AI-adjacent (adjacent). See `DEFAULT_ROLES` in `src/engine/profile.mjs`.

> `roles` drives *scoring*. Which titles are *collected* from company boards is controlled by `portals.yml → title_filter`, and which titles are *searched* on LinkedIn/Indeed by `discovery.apify.queries`. Keep the three consistent.

### skills

```yaml
skills: [Python, SQL, PyTorch, LLMs, RAG, AWS, Docker]
```

Each skill is matched as a whole word in the job text. The count of matches is 30% of the fit score (8+ matches = full points). If `skills` is absent, job-radar reads the bullet list under `## Skills` in `config/cv.md` (format: `- **Group:** A, B, C`).

### locations

```yaml
locations:
  preferred: ["new york", "nyc", "boston", "new jersey"]
```

Preferred locations score 4.25 (4.5 if hybrid) out of 5 on the location part (10%). Remote always scores 5; other locations 3.5. **This only affects ranking.** Which locations are allowed at all is `portals.yml → location_filter`.

### salary

```yaml
salary:
  good_k: 110      # stated minimum ≥ this → 5/5 on the salary part
  fair_k: 90       # ≥ this → 4.5/5; ≥ eligibility.salary_floor_k → 3.5/5
```

Salaries are read from structured ATS fields when present, otherwise from text like `$120,000 - $150,000`, `$120K–$150K` or `$55/hr` (hourly × 2,080). No salary = neutral 3.5.

### eligibility

Hard filters. A job that breaks one is **BLOCKED** and never shown. Unclear wording is **VERIFY**: shown, flagged, with the quoted sentence.

```yaml
eligibility:
  needs_sponsorship: true
  on_opt: true
  us_citizen: false
  graduated: true
  graduation: "2026-05"
  max_years_required: 5
  salary_floor_k: 70
  block_local_only: true
  excluded_title_words: [staff, principal, director, head of, vice president, vp, manager, distinguished, fellow]
```

| Field | Default | When `true` / set |
|---|---|---|
| `needs_sponsorship` | `true` | BLOCK "no sponsorship now or in the future"; VERIFY vaguer sponsorship wording. Set `false` if you never need a visa. |
| `on_opt` | `true` | BLOCK postings that exclude OPT / CPT / STEM OPT |
| `us_citizen` | `false` | `true` skips **all** citizenship and clearance rules |
| `graduated` | `true` | BLOCK "must be currently enrolled" |
| `graduation` | `"2026-05"` | BLOCK postings that require graduating after this month (same-year later months/seasons and the next two years). Use `none` to disable. |
| `max_years_required` | `5` | BLOCK when the smallest "N+ years" in the text is above this |
| `salary_floor_k` | `70` | BLOCK when the stated maximum is below this ($K/year) |
| `block_local_only` | `true` | BLOCK "local candidates only" / "relocation not considered" |
| `excluded_title_words` | see above | BLOCK titles containing any of these words |

PERM / labor-certification notices are always blocked, because they are legal filings, not open jobs. The full rule list with examples is in [GUARDRAILS.md § Eligibility](GUARDRAILS.md#eligibility-guardrails).

### alerts

```yaml
alerts:
  email:
    enabled: true
    min_fit: 3.5            # only jobs with fit ≥ this
    include_verify: true    # also send jobs whose eligibility is VERIFY
    subject_prefix: "[job-radar]"
```

Credentials are never in this file; see [Environment variables](#environment-variables).

### ai

```yaml
ai:
  enabled: true
  model: claude-opus-5-5     # or claude-sonnet-5-5 / claude-haiku-5-5
  max_jobs: 10               # 1–10
```

Adds a two-line "✅ why you fit / ⚠️ main gap" note per job in the email. It runs only when `ANTHROPIC_API_KEY` is set, makes one request per alert email, and never changes which jobs are sent. Cost per alert: about $0.08 with Opus, $0.002 with Haiku ([COST.md](COST.md)).

### discovery

Scan settings. **Guardrail values are clamped**: you can lower them, never raise them past the limits in [GUARDRAILS.md](GUARDRAILS.md).

```yaml
discovery:
  rotationBatch: 25          # public ATS boards sampled per scan (0–50)
  strongFit: 4.0             # stop sources early once 10 strong jobs are found
  topN: 10                   # results (1–10)
  windowHours: 24            # freshness window
  sources:                   # max 3 enabled at once
    tracked: true
    ats-rotation: true
    apify: true
    company-boards: false
  includePublicBoards: true  # RemoteOK, Remotive, The Muse, … (discovery only)
  apify:
    enabled: true
    scanCapUsd: 0.10         # max 0.25
    perRunCapUsd: 0.01
    queries:
      primary: ["AI Engineer", "Machine Learning Engineer", "Data Scientist"]
      secondary: ["Data Engineer", "Data Analyst"]
      adjacent: ["Business Analyst"]
    actors:
      linkedin: { limitPerQuery: 15, input: { location: "United States" } }
      indeed:   { limitPerQuery: 15, input: { country: us, datePosted: "1" } }
  presets: { … }             # see below
  companyBoards: { … }       # see below
```

#### Presets

`npm run scan -- <preset>`. A preset is configuration for the same pipeline and can only **narrow** a scan.

| Field | Effect |
|---|---|
| `description` | Shown in reports |
| `companies: [..]` | Only these companies (and their divisions). Uses their official boards + LinkedIn restricted to them; Indeed off. |
| `locations: [..]` | Only jobs in these places. State names expand to major cities and abbreviations (CT, NY, NJ, MA built in). |
| `includeRemote: true` | With `locations`: also keep US-remote jobs |
| `location: remote` | Only US-remote jobs |
| `category: startup` | Tracked companies tagged `category: startup` + rotating Ashby/Lever boards |
| `overrides: {..}` | Any `discovery` settings for this preset (e.g. Apify inputs) |

Built-in presets: `run`, `faang`, `staffing`, `startup`, `remote`, `local`, and `company <name>` (no entry needed). Entries in `profile.yml` are merged over the built-ins by name.

```yaml
  presets:
    banks:
      description: "Banks and fintech"
      companies: [Capital One, JPMorganChase, Goldman Sachs]
    texas:
      locations: [Texas, Austin, Dallas, Houston]
      includeRemote: false
      overrides:
        apify:
          actors:
            linkedin: { input: { location: "Texas, United States" } }
            indeed:   { input: { country: us, datePosted: "1", location: "Texas" } }
```

#### companyBoards

Official boards for companies that are not found automatically. Used by company presets and to verify LinkedIn/Indeed jobs at that company. **Oracle Recruiting Cloud sites are only ever matched through this list.** Amazon is built in.

```yaml
  companyBoards:
    JPMorganChase:
      - careers_url: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/jobs"
    Capital One:
      - careers_url: "https://capitalone.wd12.myworkdayjobs.com/Capital_One"
```

---

## portals.yml

### title_filter

Applied to every collected job before scoring.

```yaml
title_filter:
  positive: ["Data Scientist", "Machine Learning + Engineer", "word:ML Engineer"]
  negative: ["word:Staff", "Principal", "Director", "Sales"]
```

A title must contain at least one `positive` keyword and no `negative` keyword. Matching is case-insensitive.

| Syntax | Meaning |
|---|---|
| `Data Scientist` | Phrase anywhere in the title |
| `word:ML` | Whole word only (so `ML` doesn't match `HTML`) |
| `Machine Learning + Engineer` | Both parts must appear (positive list only) |

### location_filter

```yaml
location_filter:
  strict: true                       # reject jobs with no location at all
  always_allow: ["United States"]    # wins over block (also matches every US state name/code)
  allow: ["Remote", "New York City", "Boston"]
  block: ["London"]
  block_hard: ["India", "Canada", "United Kingdom"]   # always rejected, even over always_allow
```

Order of evaluation: `block_hard` → `always_allow` → `block` → `allow`. If `allow` is non-empty, a location must match one of its entries, or the title must say "Remote". Matching is whole-word, so `India` doesn't block `Indiana`.

### tracked_companies

The companies scanned on every run.

```yaml
tracked_companies:
  - name: Anthropic
    careers_url: https://job-boards.greenhouse.io/anthropic
  - name: Ramp
    careers_url: https://jobs.ashbyhq.com/ramp
    category: startup                # optional, for the startup preset
  - name: NVIDIA
    careers_url: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
  - name: Old Co
    careers_url: https://jobs.lever.co/oldco
    enabled: false                   # keep the entry, skip it
```

Supported `careers_url` hosts: `job-boards.greenhouse.io` / `boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`, `*.myworkdayjobs.com`, `jobs.smartrecruiters.com`, `*.icims.com`, Oracle `*.oraclecloud.com` sites, `amazon.jobs`. To find a company's board, open its careers page and click a job: the URL shows which ATS it uses.

### blacklist

`config/blacklist.md`, optional:

```markdown
| Company | Since | Scope | Reason |
|---|---|---|---|
| Example Staffing LLC | 2026-10-01 | company | bait-and-switch |
| example.com | 2026-10-01 | domain | |
```

`company` matches the employer name (normalized); `domain` matches the posting host and its subdomains.

---

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `GMAIL_USER` | email alerts | The Gmail address that sends alerts |
| `GMAIL_APP_PASSWORD` | email alerts | A 16-character App Password ([DEPLOYMENT.md § Gmail](DEPLOYMENT.md#1-create-a-gmail-app-password)) |
| `ALERT_TO` | — | Recipient; defaults to `GMAIL_USER` |
| `APIFY_TOKEN` | LinkedIn/Indeed | Without it, Apify is skipped and the free sources still run |
| `ANTHROPIC_API_KEY` | AI notes | Without it, emails go out without notes |
| `RADAR_APIFY` | — | `1` turns Apify on for `npm run alert` (the workflow sets it on 3 runs a day) |
| `RADAR_MCP_ALLOW_APIFY` | — | `1` lets MCP clients request paid scans |
| `JOB_RADAR_HOME` | — | Alternative root for `config/`, `state/`, `output/` |
| `TZ` | — | Timezone for "today" in freshness rules and email times (the workflow uses `America/New_York`) |

---

## Recipes

**I'm a US citizen.**

```yaml
eligibility: { us_citizen: true, needs_sponsorship: false, on_opt: false }
```

**I'm senior (8+ years) and want lead roles.**

```yaml
eligibility:
  max_years_required: 15
  excluded_title_words: [director, vice president, vp]
```

Also remove `Principal`, `Staff` and `Lead` from `portals.yml → title_filter.negative`.

**Frontend engineer instead of data/AI.**

```yaml
roles:
  - { label: "Frontend", tier: primary, keywords: ["frontend", "front-end", "react", "ui engineer"] }
  - { label: "Full-stack", tier: secondary, keywords: ["full stack", "full-stack"] }
skills: [TypeScript, React, Next.js, CSS, GraphQL, Node.js]
discovery:
  apify:
    queries: { primary: ["Frontend Engineer", "React Developer"], secondary: ["Full Stack Engineer"], adjacent: [] }
```

Update `portals.yml → title_filter.positive` to match.

**Only email near-perfect matches.**

```yaml
alerts: { email: { min_fit: 4.3, include_verify: false } }
```

**Never spend money.** Don't set `APIFY_TOKEN` (or set `discovery.apify.enabled: false`) and don't set `ANTHROPIC_API_KEY`.
