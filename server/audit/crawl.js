/**
 * The crawl phase.
 *
 * The crawl runs in chunks: each chunk leases up to CHUNK_TARGET_PAGES URLs
 * from the frontier and crawls them with a rolling concurrency window — the
 * moment a fetch settles the next URL launches, so one slow page occupies one
 * slot instead of stalling a whole batch. Results persist in sub-batches while
 * later fetches are still in flight, and the window re-adapts on every
 * sub-batch, so the crawler learns the site's weight and health as it goes.
 */
import * as frontier from "./frontier.js";
import * as repo from "./repository.js";
import { crawlPage } from "./crawlPage.js";
import { runPageReporters } from "./issues/pageReporters.js";
import { deterministicAuditRowId } from "./ids.js";
import { isSameOrigin } from "./urlUtils.js";
import { isCrawlableUrl } from "./urlPolicy.js";
import {
  adjustCrawlWindow,
  clampCrawlWindow,
  CRAWL_WINDOW,
} from "./crawlWindow.js";
import { createCrawlThrottle } from "./crawlThrottle.js";

const CHUNK_TARGET_PAGES = 200;
/** Stop launching new fetches after this long; leftover leases are released. */
const CHUNK_SOFT_DEADLINE_MS = 90_000;
/** Crawled pages are persisted in sub-batches of this size. */
const PERSIST_BATCH_SIZE = 25;
/**
 * The first sub-batch of a chunk is deliberately small: the crawl window only
 * adapts when a sub-batch persists, so a few pages tell the byte bound what
 * the site's pages weigh before the window commits to more.
 */
const FIRST_PERSIST_BATCH_SIZE = 5;
/**
 * Mega-menu/footer-heavy sites can carry 1000+ links per page; cap what we
 * record so a large crawl can't produce tens of millions of link targets to
 * scan at finalize.
 */
const MAX_STORED_LINKS_PER_PAGE = 500;
/**
 * Cap newly discovered URLs enqueued per persist sub-batch. A crawler-trap
 * page family (faceted nav, calendars) can emit tens of thousands of unique
 * URLs per page. Dropped URLs are usually re-discovered from later pages, and
 * a site generating this many is past maxPages anyway.
 */
const MAX_DISCOVERED_PER_BATCH = 20_000;

function shouldQueueCrawlLink(link, origin, robots) {
  return (
    isSameOrigin(link, origin) && isCrawlableUrl(link) && robots.isAllowed(link)
  );
}

/**
 * @returns {Promise<{pagesCrawled: number, completed: boolean,
 *   rateLimited?: boolean}>} `completed` is true when the frontier was
 * exhausted before hitting maxPages.
 */
export async function runCrawlPhase(params) {
  const { auditId, maxPages, seededCount, shouldStop } = params;
  let chunkNo = 0;
  let attemptedTotal = 0;
  let pending = seededCount;
  let zeroProgressChunks = 0;
  // The adapted window carries across chunks: without this every chunk would
  // restart at the initial window and re-learn the site's page weight.
  let windowHint = CRAWL_WINDOW.initial;
  let throttleState;

  while (pending > 0 && attemptedTotal < maxPages) {
    if (shouldStop?.()) break;
    chunkNo += 1;
    const result = await runCrawlChunk({
      ...params,
      attemptedBefore: attemptedTotal,
      startWindow: windowHint,
      throttleState,
    });

    attemptedTotal = result.attempted;
    pending = result.pending;
    windowHint = result.endWindow;
    throttleState = result.throttleState;

    if (result.rateLimited) {
      return { pagesCrawled: attemptedTotal, completed: false, rateLimited: true };
    }

    if (pending > 0 && attemptedTotal < maxPages && result.resumeAt) {
      const waitMs = result.resumeAt - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      zeroProgressChunks = 0;
      continue;
    }

    // Two chunks in a row that crawled nothing means the frontier is
    // unservable — stop with what we have instead of spinning forever.
    zeroProgressChunks = result.attemptedInChunk === 0 ? zeroProgressChunks + 1 : 0;
    if (zeroProgressChunks >= 2) break;
  }

  return { pagesCrawled: attemptedTotal, completed: pending === 0 };
}

async function runCrawlChunk(input) {
  const { auditId, maxPages, attemptedBefore } = input;

  const claimLimit = Math.min(CHUNK_TARGET_PAGES, maxPages - attemptedBefore);
  const claimed = frontier.claimChunk(auditId, claimLimit);
  const deadlineAt = Date.now() + CHUNK_SOFT_DEADLINE_MS;
  const throttle = createCrawlThrottle(deadlineAt, input.throttleState);

  if (claimed.length === 0) {
    const stats = frontier.getStats(auditId);
    return {
      attemptedInChunk: 0,
      attempted: stats.attempted,
      pending: stats.pending,
      endWindow: input.startWindow,
      throttleState: throttle.state,
      rateLimited: throttle.stopped,
      resumeAt:
        throttle.state.pausedUntil > Date.now()
          ? throttle.state.pausedUntil
          : undefined,
    };
  }

  const depthByUrl = new Map(claimed.map((entry) => [entry.url, entry.depth]));

  let windowSize = clampCrawlWindow(input.startWindow);
  let nextIndex = 0;
  let attemptedInChunk = 0;
  const inFlight = new Set();
  const deferred = [];
  let persistThreshold = FIRST_PERSIST_BATCH_SIZE;
  let batch = [];
  // Persistence runs concurrently with fetching (pipelined) but sequentially
  // with itself, so write pressure stays bounded at one batch at a time.
  let persistChain = Promise.resolve();

  const flush = () => {
    if (batch.length === 0) return;
    const pages = batch;
    batch = [];
    persistThreshold = PERSIST_BATCH_SIZE;
    windowSize = adjustCrawlWindow(windowSize, pages);
    persistChain = persistChain.then(() =>
      persistCrawledPages({ ...input, pages, depthByUrl }),
    );
  };

  const launch = (entry) => {
    const promise = crawlPage(entry.url, entry.depth, entry.inSitemap, throttle)
      .then((page) => {
        if (!page) {
          deferred.push(entry.url);
          return;
        }
        attemptedInChunk += 1;
        batch.push(page);
        if (batch.length >= persistThreshold) flush();
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
  };

  for (;;) {
    while (
      inFlight.size < windowSize &&
      nextIndex < claimed.length &&
      Date.now() < deadlineAt &&
      !throttle.stopped &&
      !input.shouldStop?.()
    ) {
      launch(claimed[nextIndex]);
      nextIndex += 1;
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
      continue;
    }
    break;
  }
  flush();
  await persistChain;

  // Preserve URLs without a page result, including slots stopped by a cooldown.
  const unattempted = [
    ...deferred,
    ...claimed.slice(nextIndex).map((entry) => entry.url),
  ];
  if (unattempted.length > 0) frontier.releaseUrls(auditId, unattempted);

  const stats = frontier.getStats(auditId);
  const throttleState = throttle.state;
  return {
    attemptedInChunk,
    attempted: stats.attempted,
    pending: stats.pending,
    endWindow: windowSize,
    rateLimited: throttle.stopped,
    throttleState,
    resumeAt:
      throttleState.pausedUntil > Date.now()
        ? throttleState.pausedUntil
        : undefined,
  };
}

async function persistCrawledPages({
  auditId,
  origin,
  robots,
  pages,
  depthByUrl,
  maxPages,
}) {
  // Deterministic ids keep every write idempotent.
  for (const page of pages) {
    page.id = deterministicAuditRowId(auditId, page.url);
  }
  const issues = pages.flatMap((page) => runPageReporters(page));

  const links = [];
  const discovered = new Map();
  for (const page of pages) {
    const pageDepth = depthByUrl.get(page.url) ?? null;
    const childDepth = pageDepth === null ? null : pageDepth + 1;

    const targets = [];
    for (const link of page.links) {
      if (!link.isInternal) continue;
      if (targets.length < MAX_STORED_LINKS_PER_PAGE) {
        targets.push(link.targetUrl);
      }
      if (
        discovered.size < MAX_DISCOVERED_PER_BATCH &&
        !discovered.has(link.targetUrl) &&
        shouldQueueCrawlLink(link.targetUrl, origin, robots)
      ) {
        discovered.set(link.targetUrl, childDepth);
      }
    }
    if (targets.length > 0) {
      links.push({ pageId: page.id, url: page.url, targets });
    }

    // Redirect targets continue the same navigation path: same depth.
    if (
      page.redirectUrl &&
      !discovered.has(page.redirectUrl) &&
      shouldQueueCrawlLink(page.redirectUrl, origin, robots)
    ) {
      discovered.set(page.redirectUrl, pageDepth);
    }
  }

  repo.insertCrawledBatch(auditId, pages, issues, links);
  frontier.recordBatch(
    auditId,
    pages.map((page) => page.url),
    Array.from(discovered, ([url, depth]) => ({ url, depth })),
  );

  const stats = frontier.getStats(auditId);
  repo.updateAuditProgress(auditId, {
    pagesCrawled: stats.attempted,
    pagesTotal: Math.min(stats.seen, maxPages),
  });
  repo.pushProgress(
    auditId,
    pages.map((page) => ({
      url: page.url,
      statusCode: page.statusCode,
      title: page.title,
      crawledAt: Date.now(),
    })),
  );
}
