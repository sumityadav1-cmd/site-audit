import { test, before } from "node:test";
import assert from "node:assert/strict";

// The policy reads ALLOW_PRIVATE_HOSTS once at import, so it must be set
// before the module is first loaded — hence the dynamic import below.
let isCrawlableUrl;
let normalizeAndValidateStartUrl;

before(async () => {
  process.env.ALLOW_PRIVATE_HOSTS =
    "intranet.example.com,10.20.0.0/16,192.168.4.7";
  ({ isCrawlableUrl, normalizeAndValidateStartUrl } = await import(
    "./urlPolicy.js"
  ));
});

test("private targets stay blocked unless they are listed", () => {
  assert.equal(isCrawlableUrl("http://10.20.1.5/"), true, "inside the CIDR");
  assert.equal(isCrawlableUrl("http://192.168.4.7/"), true, "exact IP");
  assert.equal(isCrawlableUrl("http://intranet.example.com/"), true, "exact host");

  assert.equal(isCrawlableUrl("http://10.21.1.5/"), false, "outside the CIDR");
  assert.equal(isCrawlableUrl("http://192.168.4.8/"), false, "neighbouring IP");
  assert.equal(isCrawlableUrl("http://other.internal/"), false, "unlisted host");
  assert.equal(isCrawlableUrl("http://127.0.0.1/"), false, "loopback");
});

test("cloud metadata endpoints cannot be allowlisted", async () => {
  // Listed explicitly in the env below and still refused.
  process.env.ALLOW_PRIVATE_HOSTS = "169.254.169.254,metadata.google.internal";
  // Re-imported with a cache-busting query so the module re-reads the env.
  const policy = await import("./urlPolicy.js?metadata-check");

  assert.equal(policy.isCrawlableUrl("http://169.254.169.254/"), false);
  assert.equal(policy.isCrawlableUrl("http://metadata.google.internal/"), false);
  await assert.rejects(
    () => policy.normalizeAndValidateStartUrl("http://169.254.169.254/"),
    /cannot be audited/,
  );
});

test("an allowlisted host is accepted as a start URL", async () => {
  const url = await normalizeAndValidateStartUrl("10.20.1.5");
  assert.equal(url, "https://10.20.1.5/");
});

test("an unlisted private host is refused as a start URL", async () => {
  await assert.rejects(
    () => normalizeAndValidateStartUrl("http://10.99.0.1/"),
    /cannot be audited/,
  );
});
