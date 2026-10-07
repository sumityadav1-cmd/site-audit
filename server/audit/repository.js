/**
 * All SQL for the audit feature. Every write is idempotent on a stable key, so
 * a re-run of a partially written batch completes it instead of duplicating it.
 */
import { db } from "../db.js";
import { getIssueDescriptor } from "../../shared/auditIssues.js";
import { deterministicAuditRowId } from "./ids.js";

/** Keep the live progress feed bounded; it is only read while a crawl runs. */
const MAX_PROGRESS_ENTRIES = 300;
const MAX_PROGRESS_TITLE_CHARS = 300;

const insertAuditStmt = db.prepare(`
  INSERT INTO audits (id, start_url, status, config, pages_total)
  VALUES (@id, @startUrl, 'running', @config, @pagesTotal)
`);

const insertPageStmt = db.prepare(`
  INSERT OR REPLACE INTO audit_pages (
    id, audit_id, url, status_code, redirect_url, title, meta_description,
    canonical_url, robots_meta, x_robots_tag, header_canonical_url,
    og_title, og_description, og_image,
    h1_count, h2_count, h3_count, h4_count, h5_count, h6_count,
    heading_order_json, word_count, images_total, images_missing_alt,
    images_json, internal_link_count, external_link_count,
    has_structured_data, hreflang_tags_json, is_indexable,
    crawl_depth, in_sitemap, content_hash, fetch_class, response_time_ms
  ) VALUES (
    @id, @auditId, @url, @statusCode, @redirectUrl, @title, @metaDescription,
    @canonicalUrl, @robotsMeta, @xRobotsTag, @headerCanonicalUrl,
    @ogTitle, @ogDescription, @ogImage,
    @h1Count, @h2Count, @h3Count, @h4Count, @h5Count, @h6Count,
    @headingOrderJson, @wordCount, @imagesTotal, @imagesMissingAlt,
    @imagesJson, @internalLinkCount, @externalLinkCount,
    @hasStructuredData, @hreflangTagsJson, @isIndexable,
    @crawlDepth, @inSitemap, @contentHash, @fetchClass, @responseTimeMs
  )
`);

const insertIssueStmt = db.prepare(`
  INSERT OR REPLACE INTO audit_issues
    (id, audit_id, page_id, page_url, issue_type, severity, details_json)
  VALUES (@id, @auditId, @pageId, @pageUrl, @issueType, @severity, @detailsJson)
`);

const insertLinksStmt = db.prepare(`
  INSERT OR REPLACE INTO audit_links (audit_id, page_id, url, targets_json)
  VALUES (?, ?, ?, ?)
`);

const insertProgressStmt = db.prepare(`
  INSERT OR REPLACE INTO audit_progress
    (audit_id, seq, url, status_code, title, crawled_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertLighthouseStmt = db.prepare(`
  INSERT OR REPLACE INTO audit_lighthouse_results (
    id, audit_id, page_id, strategy,
    performance_score, accessibility_score, best_practices_score, seo_score,
    lcp_ms, cls, inp_ms, ttfb_ms, cost, error_message,
    payload_json, payload_size_bytes
  ) VALUES (
    @id, @auditId, @pageId, @strategy,
    @performanceScore, @accessibilityScore, @bestPracticesScore, @seoScore,
    @lcpMs, @cls, @inpMs, @ttfbMs, @cost, @errorMessage,
    @payloadJson, @payloadSizeBytes
  )
`);

export function createAudit({ id, startUrl, config, pagesTotal }) {
  insertAuditStmt.run({
    id,
    startUrl,
    config: JSON.stringify(config),
    pagesTotal,
  });
}

export const insertLighthouseResults = db.transaction((auditId, results) => {
  for (const result of results) {
    const payloadJson = result.payload ? JSON.stringify(result.payload) : null;
    insertLighthouseStmt.run({
      id: result.id,
      auditId,
      pageId: result.pageId,
      strategy: result.strategy,
      performanceScore: result.performanceScore,
      accessibilityScore: result.accessibilityScore,
      bestPracticesScore: result.bestPracticesScore,
      seoScore: result.seoScore,
      lcpMs: result.lcpMs,
      cls: result.cls,
      inpMs: result.inpMs,
      ttfbMs: result.ttfbMs,
      cost: result.cost,
      errorMessage: result.errorMessage,
      payloadJson,
      payloadSizeBytes: payloadJson ? Buffer.byteLength(payloadJson) : null,
    });
  }
});

/** Result rows for the Performance tab — without the payload bodies. */
export function getLighthouseResults(auditId) {
  return db
    .prepare(
      `SELECT id, page_id AS pageId, strategy,
              performance_score AS performanceScore,
              accessibility_score AS accessibilityScore,
              best_practices_score AS bestPracticesScore,
              seo_score AS seoScore,
              lcp_ms AS lcpMs, cls, inp_ms AS inpMs, ttfb_ms AS ttfbMs,
              cost, error_message AS errorMessage,
              payload_size_bytes AS payloadSizeBytes,
              created_at AS createdAt
         FROM audit_lighthouse_results WHERE audit_id = ?
         ORDER BY page_id, strategy`,
    )
    .all(auditId);
}

/** One result's stored payload, for the Lighthouse issues screen. */
export function getLighthouseResult(resultId) {
  const row = db
    .prepare(
      `SELECT id, audit_id AS auditId, page_id AS pageId, strategy,
              error_message AS errorMessage, payload_json AS payloadJson,
              created_at AS createdAt
         FROM audit_lighthouse_results WHERE id = ?`,
    )
    .get(resultId);
  if (!row) return null;
  return { ...row, payload: row.payloadJson ? JSON.parse(row.payloadJson) : null };
}

export function getLighthouseCost(auditId) {
  return (
    db
      .prepare(
        `SELECT SUM(cost) AS total FROM audit_lighthouse_results
          WHERE audit_id = ?`,
      )
      .get(auditId).total ?? 0
  );
}

export function updateAuditProgress(auditId, fields) {
  const columns = {
    pagesCrawled: "pages_crawled",
    pagesTotal: "pages_total",
    lighthouseTotal: "lighthouse_total",
    lighthouseCompleted: "lighthouse_completed",
    lighthouseFailed: "lighthouse_failed",
    currentPhase: "current_phase",
  };
  const assignments = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (assignments.length === 0) return;
  values.push(auditId);
  db.prepare(
    `UPDATE audits SET ${assignments.join(", ")} WHERE id = ?`,
  ).run(...values);
}

export function completeAudit(auditId, { pagesCrawled, pagesTotal }) {
  db.prepare(
    `UPDATE audits
        SET status = 'completed', pages_crawled = ?, pages_total = ?,
            current_phase = 'done', completed_at = datetime('now')
      WHERE id = ?`,
  ).run(pagesCrawled, pagesTotal, auditId);
}

export function failAudit(auditId, { errorCode, errorDetail }) {
  db.prepare(
    `UPDATE audits
        SET status = 'failed', error_code = ?, error_detail = ?,
            failed_phase = current_phase, completed_at = datetime('now')
      WHERE id = ? AND status = 'running'`,
  ).run(errorCode, String(errorDetail ?? "").slice(0, 2_000), auditId);
}

/**
 * Persist one sub-batch of crawled pages with their per-page issues and
 * internal link targets, in one transaction. Row ids are derived from
 * (audit id, URL), so a retried batch overwrites its own rows rather than
 * duplicating them.
 */
export const insertCrawledBatch = db.transaction(
  (auditId, pages, issues, links) => {
    for (const page of pages) {
      insertPageStmt.run({
        id: page.id,
        auditId,
        url: page.url,
        statusCode: page.statusCode || null,
        redirectUrl: page.redirectUrl,
        title: page.title,
        metaDescription: page.metaDescription,
        canonicalUrl: page.canonicalUrl,
        robotsMeta: page.robotsMeta,
        xRobotsTag: page.xRobotsTag,
        headerCanonicalUrl: page.headerCanonicalUrl,
        ogTitle: page.ogTitle,
        ogDescription: page.ogDescription,
        ogImage: page.ogImage,
        h1Count: page.h1Count,
        h2Count: page.h2Count,
        h3Count: page.h3Count,
        h4Count: page.h4Count,
        h5Count: page.h5Count,
        h6Count: page.h6Count,
        headingOrderJson: JSON.stringify(page.headingOrder),
        wordCount: page.wordCount,
        imagesTotal: page.imagesTotal,
        imagesMissingAlt: page.imagesMissingAlt,
        imagesJson: JSON.stringify(page.images.slice(0, 100)),
        internalLinkCount: page.links.filter((link) => link.isInternal).length,
        externalLinkCount: page.links.filter((link) => !link.isInternal).length,
        hasStructuredData: page.hasStructuredData ? 1 : 0,
        hreflangTagsJson: JSON.stringify(page.hreflangTags),
        isIndexable: page.isIndexable ? 1 : 0,
        crawlDepth: page.crawlDepth,
        inSitemap: page.inSitemap ? 1 : 0,
        contentHash: page.contentHash,
        fetchClass: page.fetchClass,
        responseTimeMs: page.responseTimeMs,
      });
    }
    insertIssuesRows(auditId, issues);
    for (const link of links) {
      insertLinksStmt.run(
        auditId,
        link.pageId,
        link.url,
        JSON.stringify(link.targets),
      );
    }
  },
);

function insertIssuesRows(auditId, issues) {
  for (const issue of issues) {
    const descriptor = getIssueDescriptor(issue.issueType);
    insertIssueStmt.run({
      id: deterministicAuditRowId(
        auditId,
        issue.issueType,
        issue.pageUrl,
        issue.dedupeKey ?? "",
      ),
      auditId,
      pageId: issue.pageId,
      pageUrl: issue.pageUrl,
      issueType: issue.issueType,
      severity: descriptor?.severity ?? "info",
      detailsJson: issue.details ? JSON.stringify(issue.details) : null,
    });
  }
}

export const insertIssues = db.transaction(insertIssuesRows);

export const pushProgress = db.transaction((auditId, entries) => {
  const nextSeq =
    (db
      .prepare(`SELECT MAX(seq) AS maxSeq FROM audit_progress WHERE audit_id = ?`)
      .get(auditId).maxSeq ?? 0) + 1;
  entries.forEach((entry, index) => {
    insertProgressStmt.run(
      auditId,
      nextSeq + index,
      entry.url,
      entry.statusCode || null,
      (entry.title ?? "").slice(0, MAX_PROGRESS_TITLE_CHARS),
      entry.crawledAt,
    );
  });
  db.prepare(
    `DELETE FROM audit_progress
      WHERE audit_id = ?
        AND seq <= (SELECT MAX(seq) FROM audit_progress WHERE audit_id = ?) - ?`,
  ).run(auditId, auditId, MAX_PROGRESS_ENTRIES);
});

export function getProgress(auditId) {
  return db
    .prepare(
      `SELECT url, status_code AS statusCode, title, crawled_at AS crawledAt
         FROM audit_progress WHERE audit_id = ? ORDER BY seq DESC`,
    )
    .all(auditId);
}

export function clearProgress(auditId) {
  db.prepare(`DELETE FROM audit_progress WHERE audit_id = ?`).run(auditId);
}

/** The crawl scratch state is only needed while the crawl runs. */
export function clearCrawlState(auditId) {
  db.prepare(`DELETE FROM frontier WHERE audit_id = ?`).run(auditId);
  db.prepare(`DELETE FROM audit_links WHERE audit_id = ?`).run(auditId);
}

export function getAudit(auditId) {
  return db
    .prepare(
      `SELECT id, start_url AS startUrl, status, config,
              pages_crawled AS pagesCrawled, pages_total AS pagesTotal,
              lighthouse_total AS lighthouseTotal,
              lighthouse_completed AS lighthouseCompleted,
              lighthouse_failed AS lighthouseFailed,
              current_phase AS currentPhase, error_code AS errorCode,
              error_detail AS errorDetail, failed_phase AS failedPhase,
              started_at AS startedAt, completed_at AS completedAt
         FROM audits WHERE id = ?`,
    )
    .get(auditId);
}

export function listAudits() {
  return db
    .prepare(
      `SELECT id, start_url AS startUrl, status, config,
              pages_crawled AS pagesCrawled, pages_total AS pagesTotal,
              lighthouse_total AS lighthouseTotal,
              started_at AS startedAt, completed_at AS completedAt
         FROM audits ORDER BY started_at DESC, rowid DESC`,
    )
    .all();
}

export function countRunningAudits() {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM audits WHERE status = 'running'`)
    .get().count;
}

export function getPages(auditId) {
  return db
    .prepare(
      `SELECT id, url, status_code AS statusCode, redirect_url AS redirectUrl,
              title, meta_description AS metaDescription,
              canonical_url AS canonicalUrl,
              header_canonical_url AS headerCanonicalUrl,
              h1_count AS h1Count, word_count AS wordCount,
              images_total AS imagesTotal,
              images_missing_alt AS imagesMissingAlt,
              internal_link_count AS internalLinkCount,
              external_link_count AS externalLinkCount,
              is_indexable AS isIndexable, crawl_depth AS crawlDepth,
              in_sitemap AS inSitemap, content_hash AS contentHash,
              fetch_class AS fetchClass, response_time_ms AS responseTimeMs
         FROM audit_pages WHERE audit_id = ? ORDER BY url`,
    )
    .all(auditId)
    .map((page) => ({
      ...page,
      isIndexable: page.isIndexable === 1,
      inSitemap: page.inSitemap === 1,
    }));
}

export function hasPages(auditId) {
  return (
    db
      .prepare(`SELECT 1 FROM audit_pages WHERE audit_id = ? LIMIT 1`)
      .get(auditId) !== undefined
  );
}

export function getIssues(auditId) {
  return db
    .prepare(
      `SELECT id, page_id AS pageId, page_url AS pageUrl,
              issue_type AS issueType, severity, details_json AS detailsJson
         FROM audit_issues WHERE audit_id = ?`,
    )
    .all(auditId);
}

/** The page rows the cross-page duplicate and redirect checks read. */
export function getPagesForMultipageChecks(auditId) {
  const shellPageIds = new Set(
    db
      .prepare(
        `SELECT page_id AS pageId FROM audit_issues
          WHERE audit_id = ? AND issue_type = 'javascript-rendering-suspected'`,
      )
      .all(auditId)
      .map((row) => row.pageId),
  );

  return db
    .prepare(
      `SELECT id, url, status_code AS statusCode, fetch_class AS fetchClass,
              redirect_url AS redirectUrl, title,
              meta_description AS metaDescription,
              content_hash AS contentHash, word_count AS wordCount,
              is_indexable AS isIndexable, canonical_url AS canonicalUrl,
              header_canonical_url AS headerCanonicalUrl
         FROM audit_pages WHERE audit_id = ?`,
    )
    .all(auditId)
    .filter((page) => !shellPageIds.has(page.id))
    .map((page) => ({ ...page, isIndexable: page.isIndexable === 1 }));
}

export function hasUnreadShells(auditId) {
  return (
    db
      .prepare(
        `SELECT 1 FROM audit_issues
          WHERE audit_id = ? AND issue_type = 'javascript-rendering-suspected'
          LIMIT 1`,
      )
      .get(auditId) !== undefined
  );
}

export function countPagesByFetchClass(auditId, fetchClass) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_pages
        WHERE audit_id = ? AND fetch_class = ?`,
    )
    .get(auditId, fetchClass).count;
}

export function deleteAudit(auditId) {
  db.prepare(`DELETE FROM audits WHERE id = ?`).run(auditId);
}
