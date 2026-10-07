/**
 * Deterministic row ids for audit data.
 *
 * Page rows and issue rows are written in batches while the crawl runs. Ids
 * derived from stable content (audit id + URL + ...) combined with
 * INSERT OR REPLACE make those writes idempotent, so a re-run of a partially
 * written batch completes it instead of duplicating it under fresh random ids.
 */
import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function deterministicAuditRowId(...parts) {
  return sha256Hex(parts.join("|")).slice(0, 36);
}

export { randomUUID };
