/**
 * robots.txt and sitemap.xml discovery for the site audit crawler.
 */
import robotsParser from "robots-parser";
import { XMLParser } from "fast-xml-parser";
import { isSameOrigin, normalizeUrl } from "./urlUtils.js";
import { isCrawlableUrl } from "./urlPolicy.js";
import { CRAWL_USER_AGENT } from "../../shared/auditLimits.js";

const SITEMAP_FETCH_TIMEOUT_MS = 15_000;
// RFC 9309 requires parsers to handle at least 500 KiB of robots.txt and
// permits ignoring anything beyond it — Google does exactly that. This cap
// matches standard crawler behavior and keeps a misbehaving server (e.g. HTML
// served at /robots.txt) from being read whole.
const MAX_ROBOTS_TXT_BYTES = 500 * 1024;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;
const SITEMAP_CONCURRENCY = 5;
const SITEMAP_RETRIES = 1;
// Sitemap shards can legally reach 50 MB and SITEMAP_CONCURRENCY of them are
// read at once. Oversized shards are skipped whole — truncated XML would not
// parse anyway, and real generators shard far below this.
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
const MAX_DISCOVERY_REDIRECT_HOPS = 5;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "sitemap" || name === "url",
});

/**
 * Redirects are followed by hand so each hop is revalidated against the crawl
 * policy, instead of letting fetch follow a chain off-site.
 */
async function fetchFollowingRedirects(url, timeoutMs) {
  // One budget for the whole chain.
  const deadline = Date.now() + timeoutMs;
  let current = url;
  for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECT_HOPS; hop++) {
    const response = await fetch(current, {
      headers: { "User-Agent": CRAWL_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return null;

    let next;
    try {
      next = new URL(location, current).toString();
    } catch {
      return null;
    }
    if (!isCrawlableUrl(next)) return null;
    current = next;
  }
  return null;
}

/**
 * Fetch the raw robots.txt body (null = missing/unreachable). Kept separate
 * from parsing so the crawl can store the text and re-derive the same parsed
 * rules later — a live re-fetch could differ and desync the frontier from
 * pages already crawled under the old rules.
 */
async function fetchRobotsTxtText(origin) {
  try {
    const fetched = await fetchFollowingRedirects(
      `${origin}/robots.txt`,
      10_000,
    );
    if (!fetched?.response.ok) return null;
    return (await fetched.response.text()).slice(0, MAX_ROBOTS_TXT_BYTES);
  } catch (error) {
    console.warn("Failed to fetch robots.txt:", error.message);
    return null;
  }
}

/** Deterministic: same text in, same result out. Null = everything allowed. */
export function parseRobotsTxt(origin, text) {
  if (text === null) {
    return { isAllowed: () => true, sitemapUrls: [] };
  }

  const robots = robotsParser(`${origin}/robots.txt`, text);
  return {
    isAllowed: (url) => robots.isAllowed(url, CRAWL_USER_AGENT) ?? true,
    sitemapUrls: robots.getSitemaps(),
  };
}

function isProbablySitemapXml(contentType, body) {
  if (contentType?.toLowerCase().includes("xml")) return true;

  const trimmed = body.trimStart().toLowerCase();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<urlset") ||
    trimmed.startsWith("<sitemapindex")
  );
}

function isRecord(value) {
  return !!value && typeof value === "object";
}

function getSitemapLocations(input) {
  if (!input) return [];
  const entries = Array.isArray(input) ? input : [input];
  return entries
    .map((entry) => (isRecord(entry) ? entry["loc"] : null))
    .filter((loc) => typeof loc === "string");
}

function getParsedSitemapSections(parsed) {
  if (!isRecord(parsed)) return { sitemap: undefined, url: undefined };
  return {
    sitemap: parsed.sitemapindex?.sitemap,
    url: parsed.urlset?.url,
  };
}

function isTimeoutError(error) {
  return Boolean(error && typeof error === "object" && error.name === "TimeoutError");
}

/** Read a response body up to maxBytes; null when the body exceeds it. */
async function readBodyCapped(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchSitemapDocumentWithRetry(sitemapUrl) {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl) {
    return { nestedSitemaps: [], pageUrls: [], timedOut: false };
  }

  let lastError = null;

  for (let attempt = 0; attempt <= SITEMAP_RETRIES; attempt++) {
    try {
      const fetched = await fetchFollowingRedirects(
        normalizedSitemapUrl,
        SITEMAP_FETCH_TIMEOUT_MS,
      );
      if (!fetched) return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      const { response } = fetched;

      const finalUrl = normalizeUrl(fetched.finalUrl, normalizedSitemapUrl);
      if (!finalUrl || !isSameOrigin(finalUrl, normalizedSitemapUrl)) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }
      if (!response.ok) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const body = await readBodyCapped(response, MAX_SITEMAP_BYTES);
      if (
        body === null ||
        !isProbablySitemapXml(response.headers.get("content-type"), body)
      ) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const sections = getParsedSitemapSections(xmlParser.parse(body));
      const nestedSitemaps = getSitemapLocations(sections.sitemap)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc) => loc !== null);
      const pageUrls = getSitemapLocations(sections.url)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc) => loc !== null);

      return { nestedSitemaps, pageUrls, timedOut: false };
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt === SITEMAP_RETRIES) break;
    }
  }

  return {
    nestedSitemaps: [],
    pageUrls: [],
    timedOut: isTimeoutError(lastError),
  };
}

/**
 * Discover page URLs from robots.txt + sitemaps for an origin. Also tries the
 * default /sitemap.xml when robots.txt doesn't list one.
 */
export async function discoverUrls(origin, maxPages = 50) {
  const robotsText = await fetchRobotsTxtText(origin);
  const robots = parseRobotsTxt(origin, robotsText);

  const sitemapSources = new Set(robots.sitemapUrls);
  sitemapSources.add(`${origin}/sitemap.xml`);

  const maxDiscoveredUrls = Math.min(Math.max(maxPages * 20, 500), 50_000);
  const allUrls = new Set();

  const queue = Array.from(sitemapSources)
    .map((url) => normalizeUrl(url, origin))
    .filter((url) => url !== null)
    .filter((url) => isSameOrigin(url, origin))
    .map((url) => ({ url, depth: MAX_SITEMAP_DEPTH }));
  const seenSitemapDocs = new Set();
  let fetchedDocs = 0;
  let failedDocs = 0;
  let timedOutDocs = 0;

  while (queue.length > 0 && allUrls.size < maxDiscoveredUrls) {
    if (fetchedDocs >= MAX_SITEMAP_DOCS) break;
    const batch = queue.splice(0, SITEMAP_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        const normalizedUrl = normalizeUrl(url);
        if (
          !normalizedUrl ||
          !isSameOrigin(normalizedUrl, origin) ||
          depth <= 0 ||
          seenSitemapDocs.has(normalizedUrl)
        ) {
          return;
        }

        seenSitemapDocs.add(normalizedUrl);
        fetchedDocs += 1;

        const result = await fetchSitemapDocumentWithRetry(normalizedUrl);
        if (result.pageUrls.length === 0 && result.nestedSitemaps.length === 0) {
          failedDocs += 1;
          if (result.timedOut) timedOutDocs += 1;
          return;
        }

        for (const pageUrl of result.pageUrls) {
          if (!isSameOrigin(pageUrl, origin)) continue;
          if (allUrls.size >= maxDiscoveredUrls) break;
          allUrls.add(pageUrl);
        }

        if (depth <= 1) return;

        for (const nestedUrl of result.nestedSitemaps) {
          if (!isSameOrigin(nestedUrl, origin)) continue;
          if (!seenSitemapDocs.has(nestedUrl)) {
            queue.push({ url: nestedUrl, depth: depth - 1 });
          }
        }
      }),
    );
  }

  if (failedDocs > 0) {
    console.warn(
      `Sitemap discovery completed with partial failures for ${origin}: fetched=${fetchedDocs}, failed=${failedDocs}, timedOut=${timedOutDocs}, discoveredUrls=${allUrls.size}`,
    );
  }

  // Cap at the crawl's page budget: these are seeds, the crawl can never use
  // more.
  return { urls: Array.from(allUrls).slice(0, maxPages), robotsText };
}
