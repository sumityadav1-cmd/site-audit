// Per-audit page bounds. Shared so the launch form, the request validator and
// the server-side gate all read the same numbers and can't drift apart.
export const MIN_AUDIT_PAGES = 10;
export const DEFAULT_AUDIT_PAGES = 50;
export const MAX_AUDIT_PAGES = 10_000;

// How a page fetch resolved. "blocked" = WAF/bot challenge stood in the way;
// "rate_limited" = a 429 prevented the crawler from reading the page.
// Declared once so the SQLite column, the filters and the engine agree.
export const PAGE_FETCH_CLASSES = ["ok", "blocked", "rate_limited", "error"];

export const CRAWL_USER_AGENT = "SiteAudit/1.0";
