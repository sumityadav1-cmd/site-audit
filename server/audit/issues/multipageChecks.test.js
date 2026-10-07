import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates, findRedirectChainsAndLoops } from "./multipageChecks.js";

const page = (overrides) => ({
  id: overrides.url,
  statusCode: 200,
  fetchClass: "ok",
  title: null,
  metaDescription: null,
  contentHash: null,
  redirectUrl: null,
  wordCount: 100,
  isIndexable: true,
  canonicalUrl: null,
  headerCanonicalUrl: null,
  ...overrides,
});

test("a chain is reported once, from its head", () => {
  const issues = findRedirectChainsAndLoops([
    page({ url: "/a", statusCode: 301, redirectUrl: "/b" }),
    page({ url: "/b", statusCode: 301, redirectUrl: "/c" }),
    page({ url: "/c" }),
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].issueType, "redirect-chain");
  assert.equal(issues[0].pageUrl, "/a");
  assert.deepEqual(issues[0].details.hops, ["/a", "/b", "/c"]);
});

test("a headless cycle still produces one loop issue", () => {
  // /a and /b point at each other, so neither is a chain head.
  const issues = findRedirectChainsAndLoops([
    page({ url: "/a", statusCode: 302, redirectUrl: "/b" }),
    page({ url: "/b", statusCode: 302, redirectUrl: "/a" }),
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].issueType, "redirect-loop");
});

test("a single redirect is not a chain", () => {
  const issues = findRedirectChainsAndLoops([
    page({ url: "/a", statusCode: 301, redirectUrl: "/b" }),
    page({ url: "/b" }),
  ]);

  assert.deepEqual(issues, []);
});

test("pages the owner already de-duplicated are not duplicates", () => {
  const shared = { title: "Same", contentHash: "h1" };
  const issues = findDuplicates([
    page({ url: "/a", ...shared }),
    page({ url: "/b", ...shared, isIndexable: false }),
    page({ url: "/c", ...shared, canonicalUrl: "/a" }),
  ]);

  // Only /a survives as a candidate, and one page alone is not a group.
  assert.deepEqual(issues, []);
});

test("duplicate titles and content are reported per affected page", () => {
  const issues = findDuplicates([
    page({ url: "/a", title: "Same", contentHash: "h1" }),
    page({ url: "/b", title: "Same", contentHash: "h2" }),
  ]);

  assert.deepEqual(
    issues.map((issue) => issue.issueType),
    ["duplicate-title", "duplicate-title"],
  );
  assert.deepEqual(issues[0].details.otherUrls, ["/b"]);
});
