/**
 * The two finalize checks that need the internal link graph.
 *
 * Link edges are stored one row per page (its internal targets as a JSON
 * array) rather than one row per edge: edges dominate an audit's writes, and a
 * 10k-page crawl can carry millions of them. `json_each` expands the array at
 * query time, so the checks stay a single SQL statement each.
 */

/** Hard cap on reported broken links, so one bad template can't flood the UI. */
const MAX_BROKEN_LINK_ISSUES = 5_000;

/**
 * Every internal link whose target we crawled and saw fail. The join is on
 * audit_pages' (audit_id, url) index, so it stays an index seek per link.
 */
const BROKEN_LINKS_SQL = `
  SELECT l.page_id AS sourcePageId, l.url AS sourceUrl,
         j.value AS targetUrl, p.status_code AS targetStatus
  FROM audit_links l, json_each(l.targets_json) AS j
  JOIN audit_pages p ON p.audit_id = l.audit_id AND p.url = j.value
  WHERE l.audit_id = ?
    AND p.status_code >= 400
    AND p.fetch_class = 'ok'
  ORDER BY sourcePageId, targetUrl
  LIMIT ?
`;

/**
 * Pages nothing links to. The inbound set is built once and anti-joined rather
 * than probed per page. Self-links don't count (a page linking to itself
 * doesn't rescue it), and a page that is the target of a recorded redirect is
 * reachable, so it is not an orphan.
 */
const ORPHAN_PAGES_SQL = `
  SELECT p.id AS pageId, p.url AS url
  FROM audit_pages p
  LEFT JOIN (
    SELECT DISTINCT j.value AS targetUrl
    FROM audit_links l, json_each(l.targets_json) AS j
    WHERE l.audit_id = ? AND j.value != l.url
  ) inbound ON inbound.targetUrl = p.url
  WHERE p.audit_id = ?
    AND p.url != ?
    AND p.fetch_class = 'ok'
    AND p.status_code >= 200 AND p.status_code < 300
    AND inbound.targetUrl IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM audit_pages r
      WHERE r.audit_id = p.audit_id AND r.redirect_url = p.url
    )
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{auditId: string, startUrl: string, crawlCompleted: boolean}} input
 */
export function runLinkChecks(db, { auditId, startUrl, crawlCompleted }) {
  const brokenLinks = db
    .prepare(BROKEN_LINKS_SQL)
    .all(auditId, MAX_BROKEN_LINK_ISSUES);

  // Orphan detection only makes sense when the crawl wasn't truncated: on a
  // partial crawl, "nothing links here" usually means "we never fetched the
  // page that links here".
  const orphanPages = crawlCompleted
    ? db.prepare(ORPHAN_PAGES_SQL).all(auditId, auditId, startUrl)
    : [];

  return [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link",
      pageId: row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page",
      pageId: row.pageId,
      pageUrl: row.url,
    })),
  ];
}
