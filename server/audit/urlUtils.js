/**
 * URL normalization and utility functions for the site audit crawler.
 */

/**
 * Normalize a URL for deduplication:
 * - Resolve relative URLs against a base
 * - Strip fragments (#...)
 * - Sort query parameters
 * - Lowercase the hostname
 * - Preserve trailing slashes. A trailing slash is the canonical form on most
 *   CMS platforms (WordPress etc.), which 301-redirect the non-slash version to
 *   it. Stripping it here would rewrite the canonical URL into its own redirect
 *   source, so the crawler would follow /path -> /path/ and strip back to /path
 *   forever — a redirect loop. Keeping /path and /path/ distinct lets the
 *   redirect resolve normally.
 */
export function normalizeUrl(url, base) {
  try {
    const parsed = new URL(url, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.searchParams.sort();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * A canonical key for URL equality checks that should survive the common
 * redirect patterns a site uses to reach its canonical form:
 *   - trailing-slash redirects   (/services -> /services/)
 *   - www <-> non-www            (www.example.com -> example.com)
 *   - http -> https upgrades
 *
 * Trailing slashes are intentionally left intact so two genuinely different
 * paths never collapse together; this key is only for "is this effectively the
 * same page as the start URL" comparisons, not for crawl dedup.
 */
export function canonicalUrlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.toLowerCase();
  }
}

function getEffectivePort(parsed) {
  if (parsed.port) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

function areEquivalentHostnames(a, b) {
  const hostA = a.toLowerCase();
  const hostB = b.toLowerCase();
  if (hostA === hostB) return true;
  return hostA === `www.${hostB}` || hostB === `www.${hostA}`;
}

/**
 * Check if a URL belongs to the same crawl boundary as the crawl target.
 *
 * Rules:
 * - Hostname must match (www and apex count as the same site).
 * - Same protocol/port is always allowed.
 * - http -> https upgrade on default ports is allowed.
 */
export function isSameOrigin(url, origin) {
  try {
    const parsedUrl = new URL(url);
    const parsedOrigin = new URL(origin);

    if (!areEquivalentHostnames(parsedUrl.hostname, parsedOrigin.hostname)) {
      return false;
    }

    const originProtocol = parsedOrigin.protocol.toLowerCase();
    const urlProtocol = parsedUrl.protocol.toLowerCase();
    const originPort = getEffectivePort(parsedOrigin);
    const urlPort = getEffectivePort(parsedUrl);

    if (originProtocol === urlProtocol) {
      return originPort === urlPort;
    }

    return (
      originProtocol === "http:" &&
      urlProtocol === "https:" &&
      originPort === "80" &&
      urlPort === "443"
    );
  } catch {
    return false;
  }
}

/**
 * Detect a URL template pattern by replacing path segments that look like
 * dynamic values (IDs, slugs, dates) with `:param`.
 *
 *   /blog/my-great-post      -> /blog/:slug
 *   /products/12345          -> /products/:id
 *   /users/john-doe/settings -> /users/:slug/settings
 */
export function detectUrlTemplate(pathname) {
  const segments = pathname.split("/").filter(Boolean);

  const normalized = segments.map((segment) => {
    if (/^\d+$/.test(segment)) return ":id";
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      )
    )
      return ":uuid";
    if (/^\d{4}-\d{2}-\d{2}$/.test(segment)) return ":date";
    // Slug-like: hyphenated with more than two parts, so short fixed routes
    // like "my-account" are not mistaken for content slugs.
    if (segment.includes("-") && segment.split("-").length > 2) return ":slug";
    return segment;
  });

  return "/" + normalized.join("/");
}

export function getOrigin(url) {
  return new URL(url).origin;
}
