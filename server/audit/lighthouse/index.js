/**
 * The Lighthouse phase: pick a sample, buy the checks, store the results.
 */
import * as repo from "../repository.js";
import { deterministicAuditRowId } from "../ids.js";
import { fetchLighthousePayload } from "./dataforseo.js";
import { selectLighthouseSample } from "./sample.js";

export { isLighthouseAvailable } from "./dataforseo.js";
export { LIGHTHOUSE_SAMPLE_LIMIT } from "./sample.js";

/**
 * URLs checked concurrently. Each URL runs mobile + desktop, so one wave holds
 * up to 10 paid calls in flight; the payload parse lock serializes the
 * memory-heavy parsing behind them.
 */
const URL_CONCURRENCY = 5;

const STRATEGIES = ["mobile", "desktop"];

/** A check that produced no payload — provider error, or a failed request. */
function failedResult(url, pageId, strategy, errorMessage) {
  return {
    url,
    pageId,
    strategy,
    performanceScore: null,
    accessibilityScore: null,
    bestPracticesScore: null,
    seoScore: null,
    lcpMs: null,
    cls: null,
    inpMs: null,
    ttfbMs: null,
    cost: null,
    errorMessage,
    payload: null,
  };
}

async function runOneCheck(url, pageId, strategy) {
  try {
    const payload = await fetchLighthousePayload({ url, strategy });
    return {
      url,
      pageId,
      strategy,
      performanceScore: payload.scores.performance,
      accessibilityScore: payload.scores.accessibility,
      bestPracticesScore: payload.scores["best-practices"],
      seoScore: payload.scores.seo,
      lcpMs: payload.metrics.largestContentfulPaint.numericValue,
      cls: payload.metrics.cumulativeLayoutShift.numericValue,
      inpMs: payload.metrics.interactionToNextPaint.numericValue,
      ttfbMs: payload.metrics.serverResponseTime.numericValue,
      cost: payload.metadata.cost,
      errorMessage: null,
      payload,
    };
  } catch (error) {
    const message = error?.message ?? String(error);
    // Lighthouse runtime errors (ERRORED_DOCUMENT_REQUEST, NOT_HTML, NO_FCP)
    // mean the page didn't load for the provider's Chrome. That failure is
    // recorded on the result row, so there is nothing for us to act on.
    const isPageFault = message.includes(
      "Lighthouse encountered an error with the following code",
    );
    (isPageFault ? console.warn : console.error)(
      `Lighthouse failed for ${url} (${strategy}): ${message}`,
    );
    return failedResult(url, pageId, strategy, message);
  }
}

export async function runLighthousePhase({ auditId, startUrl, config }) {
  if (config.lighthouseStrategy === "none") return;

  const crawledPages = repo.getPages(auditId);
  const sample = new Set(
    selectLighthouseSample(
      crawledPages.map((page) => ({ ...page, statusCode: page.statusCode ?? 0 })),
      startUrl,
      config.lighthouseStrategy,
    ),
  );
  const work = crawledPages.flatMap((page) =>
    sample.has(page.url) ? [{ url: page.url, pageId: page.id }] : [],
  );

  repo.updateAuditProgress(auditId, {
    currentPhase: "lighthouse",
    lighthouseTotal: work.length * STRATEGIES.length,
    lighthouseCompleted: 0,
    lighthouseFailed: 0,
  });
  if (work.length === 0) return;

  let completed = 0;
  let failed = 0;

  for (let start = 0; start < work.length; start += URL_CONCURRENCY) {
    const wave = work.slice(start, start + URL_CONCURRENCY);
    const results = (
      await Promise.all(
        wave.map(({ url, pageId }) =>
          Promise.all(
            STRATEGIES.map((strategy) => runOneCheck(url, pageId, strategy)),
          ),
        ),
      )
    ).flat();

    // Deterministic ids keep a re-run idempotent on (audit, page, strategy).
    repo.insertLighthouseResults(
      auditId,
      results.map((result) => ({
        ...result,
        id: deterministicAuditRowId(auditId, result.pageId, result.strategy),
      })),
    );

    failed += results.filter((result) => result.errorMessage).length;
    completed += results.filter((result) => !result.errorMessage).length;
    repo.updateAuditProgress(auditId, {
      lighthouseCompleted: completed,
      lighthouseFailed: failed,
    });
  }
}
