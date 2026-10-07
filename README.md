# Site Audit

A standalone technical-SEO site auditor: crawl a site, find what's wrong with
it, and explain how to fix it. The crawler, the issue engine, the Lighthouse
integration and the report are ported from
[OpenSEO](https://github.com/every-app/open-seo)'s site-audit module, with the
same checks and the same thresholds — but as a plain React + Node app with a
SQLite file, instead of Cloudflare Workers, Workflows, Durable Objects,
D1/Postgres and a multi-tenant billing stack.

## Quick start

```bash
npm install
npm run dev          # API on :3001, UI on http://localhost:5173
```

For a single-process deployment, build the UI once and let the API serve it:

```bash
npm run build
npm start            # everything on http://localhost:3001
```

Requires Node 20+. The database is created at `data/site-audit.db` on first
run. To put it on a server, see [DEPLOY.md](DEPLOY.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `DATABASE_PATH` | `data/site-audit.db` | SQLite file location |
| `HOST` | `0.0.0.0` | Interface to bind. Set `127.0.0.1` for local-only |
| `AUTH_USER` / `AUTH_PASSWORD` | — | Both set turns on HTTP basic auth |
| `ALLOW_PRIVATE_HOSTS` | — | Allowlist of internal crawl targets (hosts + IPv4 CIDRs) |
| `MAX_RUNNING_AUDITS` | `2` | Concurrent audits allowed |
| `DATAFORSEO_API_KEY` | — | Enables the Lighthouse / Performance tab |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | — | Alternative to the key above |

## Lighthouse (optional)

Performance scores come from [DataForSEO](https://dataforseo.com)'s Lighthouse
endpoint, as in OpenSEO. The whole feature is **off until a key is present** —
no key, no Performance tab, and the launch form says why.

```bash
DATAFORSEO_API_KEY=<base64 of login:password> npm start
# or
DATAFORSEO_LOGIN=you@example.com DATAFORSEO_PASSWORD=... npm start
```

With a key, "Include Lighthouse" appears on the launch form. The audit then
samples the homepage plus one page per URL template, up to 10 pages, and checks
each on mobile and desktop — so **at most 20 billed calls per audit**. Auditing
40 blog posts that share a template measures the template 40 times and tells
you nothing new, which is what the sampling avoids.

The Performance tab lists every check with its scores and Core Web Vitals, and
"View issues" opens the full Lighthouse report for that page: score gauges, the
metric strip, and every failing audit grouped by category with its description
and affected items.

Three details carried over from OpenSEO because they matter when you're paying:

- **A 5xx is never retried.** It's a billed, non-idempotent POST — a 500 does
  not prove the provider skipped the charge.
- **The raw report is never deep-parsed.** It arrives at 1–10 MB and is reduced
  straight into a ~1 KB record; parsing it whole was OpenSEO's dominant
  out-of-memory cause. One parse runs at a time, while the HTTP calls stay
  concurrent.
- **Challenge pages are excluded from the sample.** A WAF interstitial can
  answer 200, and a paid check of it just measures the challenge.

What the audit spent is shown on the report — an addition, since OpenSEO meters
centrally and a self-hoster pays DataForSEO directly.

## What it checks

30 issue types, each with a severity, a plain-English explanation of why it
matters, and concrete fix advice. They live in one file —
[`shared/auditIssues.js`](shared/auditIssues.js) — which both the engine and the
UI read, so a check's wording can never drift from the check itself.

**Critical** — crawler blocked, server errors (5xx), broken internal links,
missing title tag.

**Warning** — pages returning 4xx, duplicate titles / meta descriptions /
content, missing meta description, missing or multiple H1, redirect chains and
loops, conflicting canonical signals, thin content, images without alt text,
orphan pages, pages with no outgoing links, rate-limited pages, a crawl stopped
early by rate limiting, and content that appears to need JavaScript.

**Info** — titles and meta descriptions too long or too short, skipped heading
levels, slow server response, noindex pages, pages canonicalized elsewhere, and
pages buried 5+ clicks deep.

## How an audit runs

```
start URL
   ├─ normalize + SSRF check          urlPolicy.js
   ├─ follow redirects to the real origin, detect the platform
   ├─ discovery: robots.txt + sitemap.xml (index recursion, 3 deep)
   │                                   discovery.js
   ├─ crawl, in chunks of 200 URLs    crawl.js
   │    ├─ frontier leases a chunk     frontier.js
   │    ├─ rolling concurrency window  crawlWindow.js
   │    ├─ 429 backoff per origin      crawlThrottle.js
   │    ├─ fetch + classify            crawlPage.js, classifyFetch.js
   │    ├─ streaming HTML extraction   pageAnalyzer.js
   │    ├─ per-page checks             issues/pageReporters.js
   │    └─ persist, enqueue new links  repository.js
   ├─ lighthouse (only with a key)    lighthouse/
   │    ├─ sample: homepage + 1 per URL template, max 10
   │    └─ 2 billed checks per URL, reduced to a ~1 KB record
   └─ finalize
        ├─ duplicates, redirect chains issues/multipageChecks.js
        └─ broken links, orphan pages  issues/linkChecks.js
```

A few details that matter more than they look:

- **The crawl window adapts.** It starts at 5 concurrent fetches and moves
  between 1 and 20 based on what the site does: errors, blocks, 429s and very
  slow responses shrink it; a clean, fast, full-size batch grows it. It is also
  capped so the average page size times the window stays inside an in-flight
  byte budget, which is what keeps a site of heavy pages from exhausting memory.
- **Rate limiting pauses the whole crawl, not one URL.** A 429 means our overall
  rate is too high. `Retry-After` is honored (both forms). When the cooldown the
  site asks for exceeds the audit's budget, the crawl stops and says so —
  unfetched URLs are never recorded as broken.
- **Blocked is not broken.** A WAF challenge, a Cloudflare interstitial or a 403
  is reported as "we could not read this page", not as a site defect. Broken
  links are only ever reported for targets we actually crawled and saw fail.
- **Parsing is a streaming tokenizer, not a DOM.** Per-page memory stays
  constant regardless of page size, and extracted links and images are capped so
  a crawler-trap page can't blow up a batch.
- **Nothing is lost to a failure.** Pages persist in sub-batches as the crawl
  runs, so an audit that dies mid-crawl still shows everything it reached
  ("stopped early after N pages") instead of a dead end.
- **The SSRF policy is real.** Private ranges, loopback, link-local, cloud
  metadata endpoints and internal TLDs are refused — on the start URL (with a
  DNS check) and on every redirect hop and discovered link.

## Layout

```
shared/        the issue catalog and limits, read by both server and client
server/
  index.js     express routes
  db.js        SQLite schema
  audit/
    service.js   start / read / list / delete
    runner.js    phase sequencing and failure classification
    crawl.js     the chunked rolling crawl
    ...          one module per concern, listed in the diagram above
client/src/    React UI: launch form, live progress, issue report, pages table
```

## Differences from OpenSEO

The audit logic is a faithful port. The surrounding platform is not, and two
capabilities did not come across:

| Left out | Why |
| --- | --- |
| **JavaScript rendering** | OpenSEO renders pages with Cloudflare Browser Run, falling back to Context.dev — both paid, both Cloudflare-specific. The `javascript-rendering-suspected` check still runs, so the report tells you when a page's HTML is an empty app shell; it just can't render it for you. |
| **Accounts, projects, billing, plan limits** | A single-user local tool has no tenants to isolate or meter. |

Infrastructure that was replaced rather than dropped:

- **Durable Object scratchpad → SQLite tables.** OpenSEO keeps the frontier and
  link graph in a per-audit Durable Object because link edges would swamp its
  shared app database. One local SQLite file has no such split, so
  `frontier` and `audit_links` sit beside the audit tables. The link-check SQL
  is the same shape, including the one-row-per-page JSON target array.
- **Cloudflare Workflows → an in-process async function.** OpenSEO's phases are
  durable steps that resume after a crash. Here a crash fails the audit — and
  the server marks any audit left `running` as failed on the next start, so a
  row can't be stuck forever. Everything already crawled is still shown.
- **Workers KV progress feed → an `audit_progress` table**, capped and cleared
  when the audit ends.
- **R2 Lighthouse payloads → a column.** OpenSEO stores the reduced report in
  R2 and keeps an `r2Key`; the reduced report is kilobytes, so here it just
  lives in the row.
- **The crawl window's bounds are wider.** OpenSEO caps concurrency at 2 to
  survive a 128 MB Cloudflare isolate. A Node process has room, so the bounds
  are 1–20 with a 64 MB in-flight budget. The adaptation rules are unchanged.

## Testing

```bash
npm test
```

Covers the logic with the subtle invariants: redirect chain and loop walking,
which pages are excluded from duplicate groups, which Lighthouse audits become
issues, and how the Lighthouse sample is drawn.
