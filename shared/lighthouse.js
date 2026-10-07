export const LIGHTHOUSE_CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];

export const LIGHTHOUSE_CATEGORY_TABS = ["all", ...LIGHTHOUSE_CATEGORIES];

export function categoryLabel(category) {
  if (category === "best-practices") return "Best practices";
  if (category === "all") return "All";
  return `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

/** Lighthouse score bands: 90+ is good, 50–89 needs work, below 50 is poor. */
export function scoreTone(score) {
  if (score == null) return null;
  if (score >= 90) return "success";
  if (score >= 50) return "warning";
  return "danger";
}
