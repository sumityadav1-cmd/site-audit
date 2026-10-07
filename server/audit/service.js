/**
 * The audit feature's public surface: start, read, list, delete.
 */
import * as repo from "./repository.js";
import { requestCancel, runAudit } from "./runner.js";
import { randomUUID } from "./ids.js";
import {
  isLighthouseAvailable,
  LIGHTHOUSE_SAMPLE_LIMIT,
} from "./lighthouse/index.js";
import {
  CrawlTargetError,
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "./urlPolicy.js";
import {
  DEFAULT_AUDIT_PAGES,
  MAX_AUDIT_PAGES,
  MIN_AUDIT_PAGES,
} from "../../shared/auditLimits.js";

/**
 * The crawler is polite per origin, but a single process shares its sockets
 * and memory across every running audit.
 */
const MAX_RUNNING_AUDITS = Number(process.env.MAX_RUNNING_AUDITS ?? 2);

export class AuditError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AuditError";
    this.status = status;
  }
}

function clampMaxPages(value) {
  const parsed = Number(value ?? DEFAULT_AUDIT_PAGES);
  if (!Number.isFinite(parsed)) return DEFAULT_AUDIT_PAGES;
  return Math.max(MIN_AUDIT_PAGES, Math.min(MAX_AUDIT_PAGES, Math.round(parsed)));
}

function parseConfig(configRaw) {
  try {
    const parsed = JSON.parse(configRaw);
    return {
      maxPages: clampMaxPages(parsed.maxPages),
      // Stored rows from before Lighthouse shipped have no strategy; an old
      // report must stay viewable, so default rather than fail the parse.
      lighthouseStrategy: parsed.lighthouseStrategy === "auto" ? "auto" : "none",
      sitePlatform: parsed.sitePlatform,
    };
  } catch {
    return { maxPages: DEFAULT_AUDIT_PAGES, lighthouseStrategy: "none" };
  }
}

/** What this deployment can do — the launch form reads this. */
export function getCapabilities() {
  return {
    canRunLighthouse: isLighthouseAvailable(),
    lighthouseSampleLimit: LIGHTHOUSE_SAMPLE_LIMIT,
    minPages: MIN_AUDIT_PAGES,
    maxPages: MAX_AUDIT_PAGES,
    defaultPages: DEFAULT_AUDIT_PAGES,
  };
}

export async function startAudit({ startUrl, maxPages, lighthouseStrategy }) {
  if (repo.countRunningAudits() >= MAX_RUNNING_AUDITS) {
    throw new AuditError(
      "Another audit is already running. Wait for it to finish.",
      409,
    );
  }

  const runLighthouse = lighthouseStrategy === "auto";
  if (runLighthouse && !isLighthouseAvailable()) {
    throw new AuditError(
      "Lighthouse needs a DataForSEO API key. Set DATAFORSEO_API_KEY and restart, or run the audit without it.",
      403,
    );
  }

  const requestedUrl = await normalizeAndValidateStartUrl(startUrl);
  // Anchor the audit to the site's real origin: a start domain that 301s
  // elsewhere (…net -> …com, apex -> www) would otherwise dead-end after one
  // page at the same-origin crawl boundary.
  const probe = await resolveStartUrlRedirects(requestedUrl);

  const config = {
    maxPages: clampMaxPages(maxPages),
    lighthouseStrategy: runLighthouse ? "auto" : "none",
    // Shopify storefronts answer with `powered-by: Shopify`; knowing this is
    // what lets the report explain a throttled crawl instead of shrugging.
    sitePlatform: probe.poweredBy?.toLowerCase().includes("shopify")
      ? "shopify"
      : undefined,
  };

  const auditId = randomUUID();
  repo.createAudit({
    id: auditId,
    startUrl: probe.url,
    config,
    pagesTotal: config.maxPages,
  });

  // Fire and forget: the audit reports its own progress and failures through
  // the audit row, which the UI polls.
  void runAudit({ auditId, startUrl: probe.url, config });

  return { auditId };
}

export function getStatus(auditId) {
  const audit = repo.getAudit(auditId);
  if (!audit) throw new AuditError("Audit not found.", 404);
  return {
    id: audit.id,
    startUrl: audit.startUrl,
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    pagesTotal: audit.pagesTotal,
    lighthouseTotal: audit.lighthouseTotal,
    lighthouseCompleted: audit.lighthouseCompleted,
    lighthouseFailed: audit.lighthouseFailed,
    currentPhase: audit.currentPhase,
    errorCode: audit.errorCode,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
  };
}

export function getResults(auditId) {
  const audit = repo.getAudit(auditId);
  if (!audit) throw new AuditError("Audit not found.", 404);

  return {
    audit: {
      id: audit.id,
      startUrl: audit.startUrl,
      status: audit.status,
      pagesCrawled: audit.pagesCrawled,
      pagesTotal: audit.pagesTotal,
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
      config: parseConfig(audit.config),
      lighthouseCost: repo.getLighthouseCost(auditId),
    },
    pages: repo.getPages(auditId),
    issues: repo.getIssues(auditId),
    lighthouse: repo.getLighthouseResults(auditId),
  };
}

/** The stored report behind one Performance row. */
export function getLighthouseIssues(resultId) {
  const result = repo.getLighthouseResult(resultId);
  if (!result) throw new AuditError("Lighthouse result not found.", 404);

  const payload = result.payload;
  return {
    id: result.id,
    auditId: result.auditId,
    strategy: result.strategy,
    createdAt: result.createdAt,
    errorMessage: result.errorMessage,
    finalUrl: payload?.metadata.finalUrl ?? null,
    // Runs stored before issue details were kept have no issues to list.
    hasIssueDetails: payload?.hasIssueDetails ?? false,
    scores: payload?.scores ?? null,
    metrics: payload?.metrics ?? null,
    issues: payload?.issues ?? [],
  };
}

export function getCrawlProgress(auditId) {
  if (!repo.getAudit(auditId)) throw new AuditError("Audit not found.", 404);
  return repo.getProgress(auditId);
}

export function getHistory() {
  return repo.listAudits().map((audit) => ({
    id: audit.id,
    startUrl: audit.startUrl,
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    pagesTotal: audit.pagesTotal,
    ranLighthouse: parseConfig(audit.config).lighthouseStrategy !== "none",
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
  }));
}

export function removeAudit(auditId) {
  const audit = repo.getAudit(auditId);
  if (!audit) throw new AuditError("Audit not found.", 404);

  if (audit.status === "running") {
    // The crawl loop checks this between chunks and before each launch, so it
    // stops without leaving the row stuck in "running".
    requestCancel(auditId);
    repo.failAudit(auditId, {
      errorCode: "cancelled",
      errorDetail: "Stopped by the user.",
    });
  }

  repo.deleteAudit(auditId);
}

export { CrawlTargetError };
