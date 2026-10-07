/**
 * SSRF policy for the crawler: what the audit is allowed to fetch.
 *
 * Private ranges, loopback, link-local, cloud metadata endpoints and internal
 * TLDs are refused. The start URL additionally gets a DNS check, because a
 * public hostname can resolve to a private address; per-link DNS lookups would
 * be far too slow, so discovered URLs get the synchronous check only.
 *
 * ALLOW_PRIVATE_HOSTS re-opens specific internal targets so an intranet site
 * can be audited. It is an allowlist, never a kill switch: each entry is an
 * exact hostname or an IPv4 CIDR, and everything not listed stays blocked. The
 * cloud metadata endpoints are not allowlistable at all — reaching those is
 * never an audit, and on a shared host it is the one request that turns this
 * crawler into a credential leak.
 */
import { lookup } from "node:dns/promises";
import { CRAWL_USER_AGENT } from "../../shared/auditLimits.js";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

/** Never reachable, whatever ALLOW_PRIVATE_HOSTS says. */
const NEVER_ALLOWED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

/** `host.example.com,10.20.0.0/16,192.168.4.7` — exact hosts and IPv4 CIDRs. */
function parseAllowList() {
  const raw = process.env.ALLOW_PRIVATE_HOSTS?.trim();
  if (!raw) return { hosts: new Set(), cidrs: [] };

  const hosts = new Set();
  const cidrs = [];
  for (const entry of raw.split(",").map((value) => value.trim().toLowerCase())) {
    if (!entry) continue;
    const cidr = parseIpv4Cidr(entry);
    if (cidr) cidrs.push(cidr);
    else hosts.add(entry);
  }
  return { hosts, cidrs };
}

function parseIpv4Cidr(entry) {
  const match = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!match) return null;
  const bits = Number(match[2]);
  const base = ipv4ToInt(match[1]);
  if (base === null || bits < 0 || bits > 32) return null;
  // A /0 would allowlist the entire internet, which is never the intent.
  if (bits === 0) return null;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function ipv4ToInt(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Read once at startup: the policy must not change under a running crawl.
const ALLOW_LIST = parseAllowList();

/** Whether this exact host (or resolved address) was explicitly allowlisted. */
function isAllowlisted(hostname) {
  const host = normalizeHost(hostname);
  if (!host || NEVER_ALLOWED_HOSTS.has(host)) return false;
  if (ALLOW_LIST.hosts.has(host)) return true;

  const asInt = ipv4ToInt(host);
  if (asInt === null) return false;
  return ALLOW_LIST.cidrs.some(({ base, mask }) => ((asInt & mask) >>> 0) === base);
}

/** Logged at boot so an operator can see the exception actually took effect. */
export function describeAllowList() {
  const count = ALLOW_LIST.hosts.size + ALLOW_LIST.cidrs.length;
  if (count === 0) return null;
  return `${count} private host pattern(s) allowlisted via ALLOW_PRIVATE_HOSTS`;
}

function normalizeHost(hostname) {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes("%")) host = host.split("%", 1)[0];
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function isPrivateIpv4(host) {
  const parts = normalizeHost(host).split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4FromIpv6(host) {
  const normalized = normalizeHost(host);
  if (!normalized.startsWith("::ffff:")) return null;

  const mapped = normalized.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return mapped;

  const segments = mapped.split(":").filter(Boolean);
  if (segments.length !== 2) return null;

  const high = Number.parseInt(segments[0], 16);
  const low = Number.parseInt(segments[1], 16);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateIpv6(host) {
  const value = normalizeHost(host);
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;

  const mappedIpv4 = parseMappedIpv4FromIpv6(value);
  return Boolean(mappedIpv4 && isPrivateIpv4(mappedIpv4));
}

function isIpLiteral(host) {
  const normalized = normalizeHost(host);
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) || normalized.includes(":");
}

function isBlockedHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (NEVER_ALLOWED_HOSTS.has(host)) return true;
  if (isAllowlisted(host)) return false;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIpLiteral(host)) return isPrivateIpv4(host) || isPrivateIpv6(host);
  return false;
}

async function hostnameResolvesToBlockedAddress(hostname) {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host)) return false;
  // An allowlisted intranet hostname resolves to a private address by design.
  if (isAllowlisted(host)) return false;

  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return false;
    return addresses.some(
      ({ address }) =>
        // A public hostname pointing into a range the operator opened is the
        // same target they already allowed, so judge the address too.
        !isAllowlisted(address) &&
        (isPrivateIpv4(address) || isPrivateIpv6(address)),
    );
  } catch {
    // A hostname that doesn't resolve isn't a policy violation; the crawl will
    // record the fetch failure on its own.
    return false;
  }
}

/**
 * Synchronous SSRF check for URLs discovered mid-crawl (links, redirect
 * targets, sitemap entries).
 */
export function isCrawlableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !isBlockedHost(parsed.hostname);
}

export class CrawlTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "CrawlTargetError";
    this.status = 400;
  }
}

export async function normalizeAndValidateStartUrl(input) {
  let raw = String(input ?? "").trim();
  if (!raw) throw new CrawlTargetError("Enter a URL to audit.");

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CrawlTargetError("That doesn't look like a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CrawlTargetError("Only http and https URLs can be audited.");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new CrawlTargetError("That host cannot be audited.");
  }
  if (await hostnameResolvesToBlockedAddress(parsed.hostname)) {
    throw new CrawlTargetError("That host resolves to a private address.");
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Follow redirects on the audit's start URL so the audit anchors to the site's
 * real origin. Without this, auditing a domain that 301s elsewhere (…net ->
 * …com, apex -> www) dead-ends after one page: the redirect target is a
 * different origin, so the same-origin crawl policy can't follow it.
 *
 * Every hop re-runs the full start-URL validation, so a redirect can't smuggle
 * the audit somewhere the user couldn't have pointed it directly. Probe
 * failures fall back to the last validated URL — the crawl records the real
 * fetch result.
 *
 * Also reports the final response's `powered-by` header, which is how a
 * Shopify storefront identifies itself.
 */
export async function resolveStartUrlRedirects(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": CRAWL_USER_AGENT },
        signal: AbortSignal.timeout(START_URL_PROBE_TIMEOUT_MS),
      });
    } catch {
      return { url: current, poweredBy: null };
    }
    if (response.status < 300 || response.status >= 400) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }
    const location = response.headers.get("location");
    if (!location) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }

    let next;
    try {
      next = new URL(location, current);
    } catch {
      return { url: current, poweredBy: null };
    }
    current = await normalizeAndValidateStartUrl(next.toString());
  }
  return { url: current, poweredBy: null };
}
