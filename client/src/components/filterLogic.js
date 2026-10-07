export const EMPTY_PAGES_FILTERS = {
  query: "",
  status: "all",
  fetchClass: "all",
  minWords: "",
  maxWords: "",
  minResponseMs: "",
  maxResponseMs: "",
  missingAlt: "all",
};

export const EMPTY_PERFORMANCE_FILTERS = {
  query: "",
  device: "all",
  status: "all",
  minPerf: "",
  maxPerf: "",
  minSeo: "",
  maxSeo: "",
  maxLcpSeconds: "",
};

function parseFilterNumber(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesRange(value, minRaw, maxRaw) {
  const min = parseFilterNumber(minRaw);
  const max = parseFilterNumber(maxRaw);
  if (min == null && max == null) return true;
  if (value == null) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

function matchesStatus(statusCode, status) {
  if (status === "all") return true;
  if (status === "missing") return statusCode == null;
  if (statusCode == null) return false;
  if (status === "ok") return statusCode >= 200 && statusCode < 300;
  if (status === "redirect") return statusCode >= 300 && statusCode < 400;
  return statusCode >= 400;
}

function hasMissingLighthouseScores(row) {
  return (
    row.performanceScore == null &&
    row.accessibilityScore == null &&
    row.bestPracticesScore == null &&
    row.seoScore == null
  );
}

export function isLighthouseFailure(row) {
  return Boolean(row.errorMessage) || hasMissingLighthouseScores(row);
}

export function filterPages(rows, filters) {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (query) {
      const haystack = [row.url, row.title, row.metaDescription]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (!matchesStatus(row.statusCode, filters.status)) return false;
    if (filters.fetchClass !== "all" && row.fetchClass !== filters.fetchClass) {
      return false;
    }
    if (!matchesRange(row.wordCount, filters.minWords, filters.maxWords)) {
      return false;
    }
    if (
      !matchesRange(
        row.responseTimeMs,
        filters.minResponseMs,
        filters.maxResponseMs,
      )
    ) {
      return false;
    }
    if (filters.missingAlt === "yes" && row.imagesMissingAlt <= 0) return false;
    if (filters.missingAlt === "no" && row.imagesMissingAlt > 0) return false;
    return true;
  });
}

export function filterPerformanceRows(rows, filters) {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (query) {
      const haystack = [row.pageUrl, row.pagePath].filter(Boolean).join(" ");
      if (!haystack.toLowerCase().includes(query)) return false;
    }
    if (filters.device !== "all" && row.strategy !== filters.device) return false;
    if (filters.status === "ok" && isLighthouseFailure(row)) return false;
    if (filters.status === "failed" && !isLighthouseFailure(row)) return false;
    if (!matchesRange(row.performanceScore, filters.minPerf, filters.maxPerf)) {
      return false;
    }
    if (!matchesRange(row.seoScore, filters.minSeo, filters.maxSeo)) return false;
    const maxLcpSeconds = parseFilterNumber(filters.maxLcpSeconds);
    if (
      maxLcpSeconds != null &&
      (row.lcpMs == null || row.lcpMs / 1000 > maxLcpSeconds)
    ) {
      return false;
    }
    return true;
  });
}

/** Nulls sort last whichever direction the column is sorted. */
export function compareNullable(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Sort rows by a column accessor, keeping nulls at the bottom. */
export function sortRows(rows, accessor, desc) {
  return [...rows].sort((left, right) => {
    const a = accessor(left);
    const b = accessor(right);
    if (a == null || b == null) return compareNullable(a, b);
    return compareNullable(a, b) * (desc ? -1 : 1);
  });
}
