/**
 * Fetch and analyze one URL into a crawled-page record.
 */
import { MAX_HTML_BYTES, readTextUpTo } from "./htmlResponse.js";
import { classifyFetch } from "./classifyFetch.js";
import { analyzeHtml } from "./pageAnalyzer.js";
import { sha256Hex, randomUUID } from "./ids.js";
import { normalizeUrl } from "./urlUtils.js";
import { CRAWL_USER_AGENT } from "../../shared/auditLimits.js";

const PAGE_FETCH_TIMEOUT_MS = 15_000;

/** Parse `Link: <url>; rel="canonical"` response headers. */
function parseLinkHeaderCanonical(linkHeader, pageUrl) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;([^]*)/);
    if (!match) continue;
    if (/rel\s*=\s*"?canonical"?/i.test(match[2])) {
      return normalizeUrl(match[1].trim(), pageUrl);
    }
  }
  return null;
}

/**
 * Fetch one URL, pausing the whole crawl and retrying while the site 429s (see
 * crawlThrottle.js). `responseTimeMs` is measured from the last attempt so
 * backoff waiting never looks like a slow server.
 */
async function fetchPage(url, throttle) {
  for (let attempt = 1; ; attempt++) {
    if (!(await throttle.ready())) return null;
    const startedAt = Date.now();
    // Manual redirect handling: each hop is recorded as its own page row and
    // its target is enqueued by the frontier, so redirect chains and loops are
    // detectable from the recorded rows. Trailing-slash redirects (/docs ->
    // /docs/) need no special handling: normalizeUrl preserves trailing
    // slashes, so /docs and /docs/ are distinct URLs and the redirect resolves
    // to its canonical target instead of cycling back to its own source.
    const response = await fetch(url, {
      headers: {
        "User-Agent": CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
    const result = {
      response,
      responseTimeMs: Date.now() - startedAt,
      // A retry means an earlier attempt was 429'd; a 429 handed back after the
      // last retry is already classified rate_limited and needs no flag.
      rateLimited: attempt > 1,
    };
    if (response.status !== 429) {
      throttle.recovered();
      return result;
    }

    const retry = await throttle.backoff(
      attempt,
      response.headers.get("retry-after"),
    );
    // The shared cooldown applies even when this URL has no retries left.
    if (!retry) return result;
    await response.body?.cancel();
  }
}

/** Null leaves this URL deferred when the shared cooldown stops its fetch. */
export async function crawlPage(url, crawlDepth, inSitemap, throttle) {
  const startTime = Date.now();

  try {
    const fetched = await fetchPage(url, throttle);
    if (!fetched) return null;
    const { response, responseTimeMs, rateLimited } = fetched;
    const statusCode = response.status;
    const xRobotsTag = response.headers.get("x-robots-tag");
    const headerCanonicalUrl = parseLinkHeaderCanonical(
      response.headers.get("link"),
      url,
    );

    if (statusCode >= 300 && statusCode < 400) {
      const location = response.headers.get("location");
      const redirectUrl = location ? normalizeUrl(location, url) : null;
      await response.body?.cancel();
      return emptyPageResult({
        url,
        statusCode,
        fetchClass: "ok",
        redirectUrl,
        responseTimeMs,
        xRobotsTag,
        headerCanonicalUrl,
        crawlDepth,
        inSitemap,
        rateLimited,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");
    // Cap what we read: the first 1 MiB still contains the SEO metadata and
    // navigation the audit needs in normal documents.
    const body = isHtml ? await readTextUpTo(response, MAX_HTML_BYTES) : "";
    if (!isHtml) await response.body?.cancel();
    const fetchClass = classifyFetch(
      statusCode,
      Boolean(response.headers.get("cf-mitigated")),
      body.slice(0, 4_000),
    );

    if (!isHtml || fetchClass !== "ok" || statusCode >= 400) {
      return emptyPageResult({
        url,
        statusCode,
        fetchClass,
        redirectUrl: null,
        responseTimeMs,
        xRobotsTag,
        headerCanonicalUrl,
        crawlDepth,
        inSitemap,
        // The body was still fetched and buffered; report its size so the crawl
        // window's byte budget sees blocked/error pages too.
        htmlBytes: body.length,
        rateLimited,
      });
    }

    const analysis = analyzeHtml(body, url, statusCode, responseTimeMs);
    const javascriptShell = analysis.javascriptShell === true;
    const robotsDirectives = [analysis.robotsMeta, xRobotsTag]
      .filter(Boolean)
      .join(",")
      .toLowerCase();
    const isIndexable = !robotsDirectives.includes("noindex");
    const headingCount = (level) =>
      analysis.headingOrder.filter((h) => h === level).length;

    // Parser strings can be slices backed by the entire HTML body. Detach the
    // finished result before the persist queue retains it: otherwise a few KB
    // of metadata can keep megabytes of decoded HTML alive per page.
    return structuredClone({
      id: randomUUID(),
      url,
      statusCode,
      fetchClass,
      redirectUrl: null,
      title: analysis.title,
      metaDescription: analysis.metaDescription,
      canonicalUrl: analysis.canonical
        ? (normalizeUrl(analysis.canonical, url) ?? analysis.canonical)
        : null,
      robotsMeta: analysis.robotsMeta,
      xRobotsTag,
      headerCanonicalUrl,
      ogTitle: analysis.ogTitle,
      ogDescription: analysis.ogDescription,
      ogImage: analysis.ogImage,
      h1Count: analysis.h1s.filter((h) => h.length > 0).length,
      h2Count: headingCount(2),
      h3Count: headingCount(3),
      h4Count: headingCount(4),
      h5Count: headingCount(5),
      h6Count: headingCount(6),
      headingOrder: analysis.headingOrder,
      wordCount: analysis.wordCount,
      contentHash:
        analysis.bodyText && !javascriptShell
          ? sha256Hex(analysis.bodyText)
          : null,
      isHtml: true,
      javascriptShell,
      htmlBytes: body.length,
      rateLimited,
      imagesTotal: analysis.images.length,
      // Only a truly absent alt attribute counts: alt="" is the correct markup
      // for decorative images.
      imagesMissingAlt: analysis.images.filter((img) => img.alt === null).length,
      images: analysis.images,
      links: analysis.links,
      hasStructuredData: analysis.hasStructuredData,
      hreflangTags: analysis.hreflangTags,
      isIndexable,
      responseTimeMs,
      crawlDepth,
      inSitemap,
    });
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    console.warn(`Failed to crawl ${url}:`, error.message);
    return emptyPageResult({
      url,
      statusCode: 0,
      fetchClass: "error",
      redirectUrl: null,
      responseTimeMs,
      xRobotsTag: null,
      headerCanonicalUrl: null,
      crawlDepth,
      inSitemap,
    });
  }
}

function emptyPageResult(input) {
  return {
    id: randomUUID(),
    url: input.url,
    statusCode: input.statusCode,
    fetchClass: input.fetchClass,
    redirectUrl: input.redirectUrl,
    title: "",
    metaDescription: "",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: input.xRobotsTag,
    headerCanonicalUrl: input.headerCanonicalUrl,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [],
    wordCount: 0,
    contentHash: null,
    isHtml: false,
    javascriptShell: false,
    htmlBytes: input.htmlBytes ?? 0,
    rateLimited: input.rateLimited ?? false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    isIndexable: false,
    responseTimeMs: input.responseTimeMs,
    crawlDepth: input.crawlDepth,
    inSitemap: input.inSitemap,
  };
}
