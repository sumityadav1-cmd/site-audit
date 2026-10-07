/**
 * Reduce a raw Lighthouse report into the compact record we store.
 *
 * The raw report is 1–10 MB. Only the envelope scalars are validated; the
 * report itself is reduced straight into this payload, which is kilobytes.
 * Deep-parsing the whole report cloned it a second time in memory and was
 * OpenSEO's dominant out-of-memory cause, so the shape here is deliberately
 * narrow.
 */
import { LIGHTHOUSE_CATEGORIES } from "../../../shared/lighthouse.js";

export const REQUEST_CATEGORIES = [
  "performance",
  "accessibility",
  "best_practices",
  "seo",
];

/** Audits that describe the page rather than prescribe a fix. */
const DIAGNOSTIC_AUDIT_KEYS = new Set([
  "largest-contentful-paint-element",
  "layout-shifts",
  "diagnostics",
  "metrics",
  "network-requests",
  "network-rtt",
  "network-server-latency",
  "main-thread-tasks",
  "screenshot-thumbnails",
  "final-screenshot",
  "script-treemap-data",
  "resource-summary",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scoreToPercent(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return Math.round(score * 100);
}

function buildStoredMetric(audit) {
  return {
    score: scoreToPercent(audit?.score),
    displayValue: audit?.displayValue ?? null,
    numericValue:
      typeof audit?.numericValue === "number" ? audit.numericValue : null,
  };
}

/** Keep the fields that identify an affected item, not the whole row. */
function compactItem(item) {
  const preferredKeys = [
    "url",
    "source",
    "nodeLabel",
    "snippet",
    "totalBytes",
    "wastedBytes",
    "wastedMs",
    "label",
    "value",
  ];

  const output = {};
  for (const key of preferredKeys) {
    if (item[key] != null) output[key] = item[key];
  }

  if (Object.keys(output).length === 0) {
    for (const [key, value] of Object.entries(item).slice(0, 6)) {
      output[key] = value;
    }
  }

  return JSON.stringify(output);
}

function getSeverity({ score, impactMs, impactBytes }) {
  if ((impactMs ?? 0) >= 300 || (impactBytes ?? 0) >= 150_000) return "critical";
  if (score != null && score < 50) return "critical";
  if ((impactMs ?? 0) >= 100 || (impactBytes ?? 0) >= 50_000) return "warning";
  if (score != null && score < 90) return "warning";
  return "info";
}

function buildStoredLighthouseIssues({ audits, categories }) {
  const hasIssueDetails = LIGHTHOUSE_CATEGORIES.some(
    (category) => (categories[category]?.auditRefs?.length ?? 0) > 0,
  );

  const issues = [];

  for (const category of LIGHTHOUSE_CATEGORIES) {
    const rawRefs = categories[category]?.auditRefs;
    const refs = Array.isArray(rawRefs) ? rawRefs : [];
    for (const ref of refs) {
      const auditKey = ref?.id;
      if (!auditKey) continue;

      const audit = audits[auditKey];
      if (!audit) continue;

      const score = scoreToPercent(audit.score);
      const scoreDisplayMode = audit.scoreDisplayMode ?? null;

      if (scoreDisplayMode === "numeric") continue;
      if (DIAGNOSTIC_AUDIT_KEYS.has(auditKey)) continue;

      const isPass =
        score == null ||
        score >= 90 ||
        scoreDisplayMode === "notApplicable" ||
        scoreDisplayMode === "informative" ||
        scoreDisplayMode === "manual" ||
        scoreDisplayMode === "error";

      if (isPass) continue;

      const impactMs =
        typeof audit.details?.overallSavingsMs === "number"
          ? audit.details.overallSavingsMs
          : null;
      const impactBytes =
        typeof audit.details?.overallSavingsBytes === "number"
          ? audit.details.overallSavingsBytes
          : null;
      const rawItems = audit.details?.items;
      // Newer "insight" audits report a single object instead of a list.
      const itemList = Array.isArray(rawItems)
        ? rawItems
        : isRecord(rawItems)
          ? [rawItems]
          : [];
      const items = itemList.filter(isRecord).slice(0, 10).map(compactItem);

      issues.push({
        category,
        auditKey,
        title: audit.title ?? auditKey,
        description: audit.description ?? "",
        score,
        scoreDisplayMode,
        displayValue: audit.displayValue ?? null,
        impactMs,
        impactBytes,
        severity: getSeverity({ score, impactMs, impactBytes }),
        items,
      });
    }
  }

  return { hasIssueDetails, issues };
}

function buildStoredLighthouseMetrics(audits) {
  return {
    firstContentfulPaint: buildStoredMetric(audits["first-contentful-paint"]),
    largestContentfulPaint: buildStoredMetric(
      audits["largest-contentful-paint"],
    ),
    totalBlockingTime: buildStoredMetric(audits["total-blocking-time"]),
    cumulativeLayoutShift: buildStoredMetric(audits["cumulative-layout-shift"]),
    speedIndex: buildStoredMetric(audits["speed-index"]),
    timeToInteractive: buildStoredMetric(audits.interactive),
    interactionToNextPaint: buildStoredMetric(
      audits["interaction-to-next-paint"],
    ),
    serverResponseTime: buildStoredMetric(audits["server-response-time"]),
  };
}

/**
 * Turn a DataForSEO Lighthouse response into the stored payload.
 * Throws with the provider's own message when the task failed.
 */
export function parseDataforseoLighthousePayload(body, { url, strategy }) {
  if (!isRecord(body)) {
    throw new Error("DataForSEO Lighthouse returned an invalid response");
  }
  if (body.status_code !== 20000) {
    throw new Error(body.status_message ?? "DataForSEO Lighthouse request failed");
  }

  const task = Array.isArray(body.tasks) ? body.tasks[0] : undefined;
  if (!task) throw new Error("DataForSEO Lighthouse response missing task");
  if (task.status_code !== 20000) {
    throw new Error(task.status_message ?? "DataForSEO Lighthouse task failed");
  }

  const result = Array.isArray(task.result) ? task.result[0] : undefined;
  if (!result) throw new Error("DataForSEO Lighthouse response missing result");

  const audits = isRecord(result.audits) ? result.audits : {};
  const categories = isRecord(result.categories) ? result.categories : {};
  const { hasIssueDetails, issues } = buildStoredLighthouseIssues({
    audits,
    categories,
  });

  return {
    version: 2,
    source: "dataforseo-lighthouse",
    hasIssueDetails,
    metadata: {
      requestedUrl: result.requestedUrl ?? url,
      finalUrl: result.finalUrl ?? result.requestedUrl ?? url,
      strategy,
      fetchedAt: new Date().toISOString(),
      lighthouseVersion: result.lighthouseVersion ?? null,
      taskId: task.id ?? null,
      cost: typeof task.cost === "number" ? task.cost : null,
    },
    scores: {
      performance: scoreToPercent(categories.performance?.score),
      accessibility: scoreToPercent(categories.accessibility?.score),
      "best-practices": scoreToPercent(categories["best-practices"]?.score),
      seo: scoreToPercent(categories.seo?.score),
    },
    metrics: buildStoredLighthouseMetrics(audits),
    issues,
  };
}
