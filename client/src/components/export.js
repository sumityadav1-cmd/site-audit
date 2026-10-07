import { getIssueDescriptor } from "@shared/auditIssues.js";

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
function toCsv(headers, rows) {
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}

function download(filename, text, mimeType) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function emit(filename, format, headers, rows, records) {
  if (format === "json") {
    download(`${filename}.json`, JSON.stringify(records, null, 2), "application/json");
    return;
  }
  download(`${filename}.csv`, toCsv(headers, rows), "text/csv");
}

const ISSUES_HEADERS = ["Severity", "Issue", "URL", "Details", "How To Fix"];

export function exportIssues(issues, format) {
  const records = issues.map((issue) => {
    const descriptor = getIssueDescriptor(issue.issueType);
    return {
      severity: issue.severity,
      issueType: issue.issueType,
      issue: descriptor?.title ?? issue.issueType,
      url: issue.pageUrl,
      details: issue.detailsJson ? JSON.parse(issue.detailsJson) : null,
      howToFix: descriptor?.howToFix ?? null,
    };
  });

  emit(
    "audit-issues",
    format,
    ISSUES_HEADERS,
    records.map((record) => [
      record.severity,
      record.issue,
      record.url,
      record.details ? JSON.stringify(record.details) : "",
      record.howToFix ?? "",
    ]),
    records,
  );
}

const PAGES_HEADERS = [
  "URL",
  "Status",
  "Title",
  "H1",
  "Words",
  "Images",
  "Missing Alt",
  "Response Time (ms)",
];

export function exportPages(pages, format) {
  const records = pages.map((page) => ({
    url: page.url,
    statusCode: page.statusCode,
    title: page.title ?? "",
    h1Count: page.h1Count,
    wordCount: page.wordCount,
    imagesTotal: page.imagesTotal,
    imagesMissingAlt: page.imagesMissingAlt,
    responseTimeMs: page.responseTimeMs,
  }));

  emit(
    "audit-pages",
    format,
    PAGES_HEADERS,
    records.map((record) => [
      record.url,
      record.statusCode,
      record.title,
      record.h1Count,
      record.wordCount,
      record.imagesTotal,
      record.imagesMissingAlt,
      record.responseTimeMs,
    ]),
    records,
  );
}

const PERFORMANCE_HEADERS = [
  "URL",
  "Device",
  "Performance",
  "Accessibility",
  "SEO",
  "LCP (ms)",
  "CLS",
  "INP (ms)",
  "TTFB (ms)",
];

export function exportPerformance(lighthouse, pages, format) {
  const records = lighthouse.map((result) => {
    const page = pages.find((candidate) => candidate.id === result.pageId);
    return {
      url: page?.url ?? "",
      strategy: result.strategy,
      performance: result.performanceScore,
      accessibility: result.accessibilityScore,
      seo: result.seoScore,
      lcpMs: result.lcpMs,
      cls: result.cls,
      inpMs: result.inpMs,
      ttfbMs: result.ttfbMs,
    };
  });

  emit(
    "audit-performance",
    format,
    PERFORMANCE_HEADERS,
    records.map((record) => [
      record.url,
      record.strategy,
      record.performance,
      record.accessibility,
      record.seo,
      record.lcpMs,
      record.cls,
      record.inpMs,
      record.ttfbMs,
    ]),
    records,
  );
}

const LIGHTHOUSE_ISSUE_HEADERS = [
  "Category",
  "Severity",
  "Score",
  "Title",
  "Display Value",
  "Description",
  "Impact (ms)",
  "Impact (bytes)",
  "Affected Items",
];

export function exportLighthouseIssues(issues, category, format) {
  emit(
    `lighthouse-${category}-issues`,
    format,
    LIGHTHOUSE_ISSUE_HEADERS,
    issues.map((issue) => [
      issue.category,
      issue.severity,
      issue.score ?? "",
      issue.title,
      issue.displayValue ?? "",
      issue.description ?? "",
      issue.impactMs ?? "",
      issue.impactBytes ?? "",
      issue.items.length,
    ]),
    issues,
  );
}
