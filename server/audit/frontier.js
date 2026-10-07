/**
 * The crawl frontier: one audit's URL queue and its seen-set.
 *
 * States are `pending` -> `leased` -> `crawled`. A chunk leases a batch, and
 * anything it doesn't get to (soft deadline, cooldown) is released back to
 * pending. The URL is the primary key, so enqueueing an already-seen URL is a
 * no-op — that is the crawl's global dedup.
 */
import { db } from "../db.js";

const seedStartStmt = db.prepare(
  `INSERT OR IGNORE INTO frontier (audit_id, url, depth, source, in_sitemap)
   VALUES (?, ?, 0, 'link', 0)`,
);

const seedSitemapStmt = db.prepare(
  // Upsert so a URL that already exists (e.g. the start URL) still gets its
  // in-sitemap flag; queue position and depth stay as first seen.
  `INSERT INTO frontier (audit_id, url, depth, source, in_sitemap)
   VALUES (?, ?, NULL, 'sitemap', 1)
   ON CONFLICT(audit_id, url) DO UPDATE SET in_sitemap = 1`,
);

const discoverStmt = db.prepare(
  // OR IGNORE: already-seen URLs (crawled, leased, or pending) keep their
  // existing row.
  `INSERT OR IGNORE INTO frontier (audit_id, url, depth, source, in_sitemap)
   VALUES (?, ?, ?, 'link', 0)`,
);

const claimStmt = db.prepare(
  // Link-discovered URLs drain before sitemap-only ones, FIFO within each
  // class: the crawl follows the site's own navigation first, so crawl depth
  // reflects real click distance from the start URL.
  `SELECT url, depth, in_sitemap AS inSitemap FROM frontier
    WHERE audit_id = ? AND state = 'pending'
    ORDER BY CASE source WHEN 'link' THEN 0 ELSE 1 END, rowid
    LIMIT ?`,
);

const leaseStmt = db.prepare(
  `UPDATE frontier SET state = 'leased' WHERE audit_id = ? AND url = ?`,
);

const crawledStmt = db.prepare(
  `UPDATE frontier SET state = 'crawled' WHERE audit_id = ? AND url = ?`,
);

const releaseStmt = db.prepare(
  `UPDATE frontier SET state = 'pending'
    WHERE audit_id = ? AND url = ? AND state = 'leased'`,
);

export const seedStart = db.transaction((auditId, url) => {
  seedStartStmt.run(auditId, url);
});

export const seedSitemapUrls = db.transaction((auditId, urls) => {
  for (const url of urls) seedSitemapStmt.run(auditId, url);
});

/** Lease the next batch of pending URLs for one crawl chunk. */
export const claimChunk = db.transaction((auditId, limit) => {
  if (limit <= 0) return [];
  const claimed = claimStmt.all(auditId, limit);
  for (const row of claimed) leaseStmt.run(auditId, row.url);
  return claimed.map((row) => ({
    url: row.url,
    depth: row.depth,
    inSitemap: row.inSitemap === 1,
  }));
});

/** Mark a sub-batch crawled and enqueue the URLs it discovered. */
export const recordBatch = db.transaction((auditId, crawledUrls, discovered) => {
  for (const url of crawledUrls) crawledStmt.run(auditId, url);
  for (const found of discovered) {
    discoverStmt.run(auditId, found.url, found.depth);
  }
});

/** Return unattempted leases to the queue (chunk soft-deadline hit). */
export const releaseUrls = db.transaction((auditId, urls) => {
  for (const url of urls) releaseStmt.run(auditId, url);
});

/**
 * @returns {{attempted: number, pending: number, seen: number}} attempted =
 * crawl attempts finished, pending = still queued, seen = every URL ever
 * enqueued.
 */
export function getStats(auditId) {
  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS count FROM frontier
        WHERE audit_id = ? GROUP BY state`,
    )
    .all(auditId);
  const byState = Object.fromEntries(rows.map((row) => [row.state, row.count]));
  const attempted = byState.crawled ?? 0;
  const pending = byState.pending ?? 0;
  const leased = byState.leased ?? 0;
  return { attempted, pending, seen: attempted + pending + leased };
}
