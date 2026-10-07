/**
 * Audit orchestration: discovery -> crawl -> finalize.
 *
 * OpenSEO runs these phases as durable Cloudflare Workflow steps so a crashed
 * run resumes from its last checkpoint. A single Node process has no such
 * machinery, so a crash fails the audit instead — but everything crawled
 * before the failure is already persisted, and the report shows it ("stopped
 * early after N pages") rather than hiding it.
 */
import * as frontier from "./frontier.js";
import * as repo from "./repository.js";
import { discoverUrls, parseRobotsTxt } from "./discovery.js";
import { runCrawlPhase } from "./crawl.js";
import { runLighthousePhase } from "./lighthouse/index.js";
import { findDuplicates, findRedirectChainsAndLoops } from "./issues/multipageChecks.js";
import { runLinkChecks } from "./issues/linkChecks.js";
import { getOrigin, isSameOrigin, normalizeUrl } from "./urlUtils.js";
import { isCrawlableUrl } from "./urlPolicy.js";
import { db } from "../db.js";

/** Audits the user asked to stop, by id. */
const cancelled = new Set();

export function requestCancel(auditId) {
  cancelled.add(auditId);
}

/**
 * Map a thrown error onto a closed vocabulary, so failures stay aggregable in
 * plain SQL instead of being a thousand distinct message strings.
 */
function classifyAuditError(error) {
  const message = String(error?.message ?? error);
  if (error?.name === "TimeoutError" || /timeout/i.test(message)) {
    return "fetch_timeout";
  }
  if (/SQLITE|database/i.test(message)) return "db_error";
  if (/heap out of memory|allocation failed/i.test(message)) return "oom";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/.test(message)) {
    return "network_error";
  }
  return "unknown";
}

export async function runAudit({ auditId, startUrl, config }) {
  try {
    const origin = getOrigin(startUrl);
    const maxPages = config.maxPages;
    const shouldStop = () => cancelled.has(auditId);

    const discovery = await runDiscoveryPhase({
      auditId,
      origin,
      startUrl,
      maxPages,
    });
    // Parsed from the stored text rather than re-fetched, so the crawl and the
    // finalize checks see the exact robots rules discovery used.
    const robots = parseRobotsTxt(origin, discovery.robotsText);

    const crawl = await runCrawlPhase({
      auditId,
      origin,
      maxPages,
      robots,
      seededCount: discovery.seededCount,
      shouldStop,
    });

    // Paid checks run before finalize, as in OpenSEO: a sample drawn from the
    // crawled pages, two checks per URL.
    if (!shouldStop()) {
      await runLighthousePhase({ auditId, startUrl, config });
    }

    finalizeAudit({ auditId, startUrl, crawl });
  } catch (error) {
    console.error(`Audit ${auditId} failed:`, error);
    repo.failAudit(auditId, {
      errorCode: classifyAuditError(error),
      errorDetail: String(error?.message ?? error),
    });
  } finally {
    cancelled.delete(auditId);
    repo.clearProgress(auditId);
  }
}

async function runDiscoveryPhase({ auditId, origin, startUrl, maxPages }) {
  const result = await discoverUrls(origin, maxPages);
  const robots = parseRobotsTxt(origin, result.robotsText);

  let seededCount = 0;
  const normalizedStart = normalizeUrl(startUrl) ?? startUrl;
  if (robots.isAllowed(normalizedStart) && isSameOrigin(normalizedStart, origin)) {
    frontier.seedStart(auditId, normalizedStart);
    seededCount += 1;
  }

  // The start URL is deliberately not excluded here: seedSitemapUrls upserts,
  // so a start URL that also appears in the sitemap keeps its queue position
  // but gains the in-sitemap flag.
  const seen = new Set();
  const seeds = [];
  for (const url of result.urls) {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (!isSameOrigin(normalized, origin)) continue;
    if (!isCrawlableUrl(normalized)) continue;
    if (!robots.isAllowed(normalized)) continue;
    seeds.push(normalized);
  }
  frontier.seedSitemapUrls(auditId, seeds);
  seededCount += seeds.filter((seed) => seed !== normalizedStart).length;

  repo.updateAuditProgress(auditId, {
    pagesTotal: Math.min(seededCount, maxPages),
    currentPhase: "crawling",
  });
  return { robotsText: result.robotsText, seededCount };
}

function finalizeAudit({ auditId, startUrl, crawl }) {
  repo.updateAuditProgress(auditId, { currentPhase: "finalizing" });

  // Integrity guard: pages are persisted during the crawl. If the crawl claims
  // pages but the database has none, fail loudly instead of completing with an
  // empty audit.
  if (crawl.pagesCrawled > 0 && !repo.hasPages(auditId)) {
    throw new Error(
      `Audit ${auditId}: crawl reported ${crawl.pagesCrawled} pages but none were persisted`,
    );
  }

  // Unrendered app shells carry a persisted coverage warning; their
  // placeholder titles and loading text must not become duplicate findings.
  const pages = repo.getPagesForMultipageChecks(auditId);
  const issues = [
    ...findDuplicates(pages),
    ...findRedirectChainsAndLoops(pages),
  ];

  issues.push(
    ...runLinkChecks(db, {
      auditId,
      // Page rows store normalized URLs; normalize the start URL the same way
      // so the orphan exclusion matches.
      startUrl: normalizeUrl(startUrl) ?? startUrl,
      crawlCompleted: crawl.completed && !repo.hasUnreadShells(auditId),
    }),
  );

  if (crawl.rateLimited) {
    issues.push({
      issueType: "crawl-rate-limited",
      pageId: null,
      pageUrl: startUrl,
    });
  }

  repo.insertIssues(auditId, issues);
  repo.completeAudit(auditId, {
    pagesCrawled: crawl.pagesCrawled,
    pagesTotal: crawl.pagesCrawled,
  });
  // Crawl scratch state (frontier, link targets) is no longer needed.
  repo.clearCrawlState(auditId);
}
