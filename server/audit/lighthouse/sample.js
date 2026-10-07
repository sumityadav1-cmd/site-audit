/**
 * Which crawled pages to spend Lighthouse calls on.
 *
 * Every check is billed twice (mobile + desktop), so the sample is the
 * homepage plus one page per URL template — auditing 40 blog posts that share
 * a template measures the template 40 times and tells you nothing new.
 */
import { canonicalUrlKey, detectUrlTemplate } from "../urlUtils.js";

export const LIGHTHOUSE_SAMPLE_LIMIT = 10;

function canonicalUrlKeyWithoutTrailingSlash(url) {
  const parsed = new URL(canonicalUrlKey(url));
  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
  }
  return parsed.toString();
}

export function selectLighthouseSample(pages, startUrl, strategy) {
  if (strategy === "none") return [];

  // Only consider pages that loaded successfully. A bot challenge can answer
  // 200, and a paid Lighthouse check of it measures the challenge.
  const validPages = pages.filter(
    (page) =>
      page.statusCode >= 200 &&
      page.statusCode < 300 &&
      page.fetchClass === "ok",
  );

  const selected = new Set();

  // Always include the start URL / homepage. Prefer an exact canonical match so
  // distinct 2xx `/path` and `/path/` pages stay distinct, then tolerate a
  // trailing-slash redirect when the exact start URL was not crawled as 2xx.
  const startKey = canonicalUrlKey(startUrl);
  const startPage =
    validPages.find((page) => canonicalUrlKey(page.url) === startKey) ??
    validPages.find(
      (page) =>
        canonicalUrlKeyWithoutTrailingSlash(page.url) ===
        canonicalUrlKeyWithoutTrailingSlash(startUrl),
    );
  if (startPage) selected.add(startPage.url);

  // Group by URL template pattern, keeping the first page seen in each group.
  const templateGroups = new Map();
  if (startPage) {
    templateGroups.set(
      detectUrlTemplate(new URL(startPage.url).pathname),
      startPage,
    );
  }
  for (const page of validPages) {
    if (selected.has(page.url)) continue;
    const template = detectUrlTemplate(new URL(page.url).pathname);
    if (!templateGroups.has(template)) templateGroups.set(template, page);
  }

  for (const page of templateGroups.values()) {
    if (selected.size >= LIGHTHOUSE_SAMPLE_LIMIT) break;
    selected.add(page.url);
  }

  return Array.from(selected);
}
