/**
 * SQLite storage for audits, pages, issues and the crawl frontier.
 *
 * OpenSEO splits this across a Cloudflare D1/Postgres app database (audits,
 * pages, issues) and a per-audit Durable Object (frontier, link edges) because
 * link edges would swamp the shared app database and a distributed crawl needs
 * a leasing frontier that lives next to the crawler. A single-process audit has
 * one database, so both live here — the table shapes and the checks that read
 * them are unchanged.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = process.env.DATABASE_PATH
  ? resolve(process.env.DATABASE_PATH)
  : resolve(process.cwd(), "data", "site-audit.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- One row per audit run.
  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    start_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    config TEXT NOT NULL DEFAULT '{}',
    pages_crawled INTEGER NOT NULL DEFAULT 0,
    pages_total INTEGER NOT NULL DEFAULT 0,
    lighthouse_total INTEGER NOT NULL DEFAULT 0,
    lighthouse_completed INTEGER NOT NULL DEFAULT 0,
    lighthouse_failed INTEGER NOT NULL DEFAULT 0,
    current_phase TEXT DEFAULT 'discovery',
    -- Failure diagnostics; null unless status = 'failed'. error_code is a
    -- closed vocabulary so failures are aggregable; error_detail is the raw
    -- message, truncated. failed_phase records the phase the audit died in.
    error_code TEXT,
    error_detail TEXT,
    failed_phase TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  -- One row per crawled page.
  CREATE TABLE IF NOT EXISTS audit_pages (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status_code INTEGER,
    redirect_url TEXT,
    title TEXT,
    meta_description TEXT,
    canonical_url TEXT,
    robots_meta TEXT,
    x_robots_tag TEXT,
    header_canonical_url TEXT,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT,
    h1_count INTEGER NOT NULL DEFAULT 0,
    h2_count INTEGER NOT NULL DEFAULT 0,
    h3_count INTEGER NOT NULL DEFAULT 0,
    h4_count INTEGER NOT NULL DEFAULT 0,
    h5_count INTEGER NOT NULL DEFAULT 0,
    h6_count INTEGER NOT NULL DEFAULT 0,
    heading_order_json TEXT,
    word_count INTEGER NOT NULL DEFAULT 0,
    images_total INTEGER NOT NULL DEFAULT 0,
    images_missing_alt INTEGER NOT NULL DEFAULT 0,
    images_json TEXT,
    internal_link_count INTEGER NOT NULL DEFAULT 0,
    external_link_count INTEGER NOT NULL DEFAULT 0,
    has_structured_data INTEGER NOT NULL DEFAULT 0,
    hreflang_tags_json TEXT,
    is_indexable INTEGER NOT NULL DEFAULT 1,
    crawl_depth INTEGER,
    in_sitemap INTEGER NOT NULL DEFAULT 0,
    -- SHA-256 of the visible body text, for duplicate-content grouping.
    content_hash TEXT,
    fetch_class TEXT NOT NULL DEFAULT 'ok',
    response_time_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS audit_pages_audit_url_idx
    ON audit_pages (audit_id, url);
  CREATE INDEX IF NOT EXISTS audit_pages_redirect_idx
    ON audit_pages (audit_id, redirect_url);

  -- One row per (issue type, affected page).
  CREATE TABLE IF NOT EXISTS audit_issues (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    page_id TEXT,
    page_url TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    details_json TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_issues_audit_type_idx
    ON audit_issues (audit_id, issue_type);

  -- One row per Lighthouse check (mobile + desktop per sampled page).
  -- OpenSEO keeps the reduced report in R2 and stores an r2Key; the reduced
  -- payload is kilobytes, so here it simply lives in the row.
  CREATE TABLE IF NOT EXISTS audit_lighthouse_results (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    performance_score INTEGER,
    accessibility_score INTEGER,
    best_practices_score INTEGER,
    seo_score INTEGER,
    lcp_ms REAL,
    cls REAL,
    inp_ms REAL,
    ttfb_ms REAL,
    cost REAL,
    error_message TEXT,
    payload_json TEXT,
    payload_size_bytes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS audit_lighthouse_audit_idx
    ON audit_lighthouse_results (audit_id);

  -- Internal link targets, one row per crawled page (JSON array of URLs)
  -- rather than one row per edge: edges dominate an audit's writes.
  CREATE TABLE IF NOT EXISTS audit_links (
    audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    url TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    PRIMARY KEY (audit_id, page_id)
  );

  -- The crawl frontier: the URL queue and its dedup set.
  CREATE TABLE IF NOT EXISTS frontier (
    audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    depth INTEGER,
    source TEXT NOT NULL,
    in_sitemap INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (audit_id, url)
  );
  CREATE INDEX IF NOT EXISTS frontier_claim_idx
    ON frontier (audit_id, state, source);

  -- Live crawl feed for the progress UI (newest first, capped per audit).
  CREATE TABLE IF NOT EXISTS audit_progress (
    audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    url TEXT NOT NULL,
    status_code INTEGER,
    title TEXT,
    crawled_at INTEGER NOT NULL,
    PRIMARY KEY (audit_id, seq)
  );
`);

/** Audits left "running" by a crash can never make progress again. */
export function failOrphanedAudits() {
  const result = db
    .prepare(
      `UPDATE audits
          SET status = 'failed',
              error_code = 'instance_lost',
              error_detail = 'The server restarted while this audit was running.',
              failed_phase = current_phase,
              completed_at = datetime('now')
        WHERE status = 'running'`,
    )
    .run();
  if (result.changes > 0) {
    console.warn(`Marked ${result.changes} interrupted audit(s) as failed.`);
  }
}
