import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDataforseoLighthousePayload } from "./payload.js";
import { selectLighthouseSample } from "./sample.js";

const audit = (overrides) => ({ score: 0.5, scoreDisplayMode: "binary", ...overrides });

function response(overrides = {}) {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "task-1",
        cost: 0.0025,
        status_code: 20000,
        result: [
          {
            requestedUrl: "https://example.com/",
            finalUrl: "https://example.com/",
            lighthouseVersion: "11.0.0",
            categories: {
              performance: { score: 0.42, auditRefs: [{ id: "render-blocking" }] },
              accessibility: { score: 0.97, auditRefs: [{ id: "image-alt" }] },
              "best-practices": { score: 0.8, auditRefs: [] },
              seo: { score: 1, auditRefs: [] },
            },
            audits: {
              "render-blocking": audit({
                title: "Eliminate render-blocking resources",
                description: "See [the docs](https://web.dev/x).",
                score: 0.2,
                details: { overallSavingsMs: 450, items: [{ url: "/a.css", wastedMs: 300 }] },
              }),
              "image-alt": audit({ title: "Images have alt", score: 0.95 }),
              "largest-contentful-paint": audit({
                score: 0.3,
                displayValue: "4.1 s",
                numericValue: 4100,
                scoreDisplayMode: "numeric",
              }),
              "server-response-time": audit({
                numericValue: 210,
                displayValue: "210 ms",
                scoreDisplayMode: "numeric",
              }),
            },
            ...overrides,
          },
        ],
      },
    ],
  };
}

test("scores, metrics and cost come through as stored fields", () => {
  const payload = parseDataforseoLighthousePayload(response(), {
    url: "https://example.com/",
    strategy: "mobile",
  });

  assert.equal(payload.scores.performance, 42);
  assert.equal(payload.scores.seo, 100);
  assert.equal(payload.metrics.largestContentfulPaint.numericValue, 4100);
  assert.equal(payload.metrics.serverResponseTime.numericValue, 210);
  assert.equal(payload.metadata.cost, 0.0025);
  assert.equal(payload.metadata.strategy, "mobile");
});

test("only failing, non-diagnostic audits become issues", () => {
  const payload = parseDataforseoLighthousePayload(response(), {
    url: "https://example.com/",
    strategy: "mobile",
  });

  // image-alt scored 95 (a pass) and LCP is scoreDisplayMode "numeric" (a
  // metric, not an action), so only the render-blocking audit survives.
  assert.deepEqual(
    payload.issues.map((issue) => issue.auditKey),
    ["render-blocking"],
  );
  const [issue] = payload.issues;
  // 450ms of savings is over the 300ms critical threshold.
  assert.equal(issue.severity, "critical");
  assert.equal(issue.impactMs, 450);
  assert.deepEqual(issue.items, ['{"url":"/a.css","wastedMs":300}']);
});

test("a failed task throws with the provider's own message", () => {
  assert.throws(
    () =>
      parseDataforseoLighthousePayload(
        { status_code: 20000, tasks: [{ status_code: 40501, status_message: "NOT_HTML" }] },
        { url: "https://example.com/", strategy: "mobile" },
      ),
    /NOT_HTML/,
  );
});

test("the sample is the homepage plus one page per URL template", () => {
  const page = (url) => ({ url, statusCode: 200, fetchClass: "ok" });
  const sample = selectLighthouseSample(
    [
      page("https://example.com/"),
      page("https://example.com/blog/my-first-post"),
      page("https://example.com/blog/another-long-post"),
      page("https://example.com/pricing"),
      // A blocked 200 is a bot challenge, not a page worth paying to measure.
      { url: "https://example.com/waf", statusCode: 200, fetchClass: "blocked" },
    ],
    "https://example.com/",
    "auto",
  );

  assert.deepEqual(sample, [
    "https://example.com/",
    "https://example.com/blog/my-first-post",
    "https://example.com/pricing",
  ]);
});
