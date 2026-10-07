import { useMemo } from "react";
import { IssuesView, resolveIssueSeverity } from "./IssuesView.jsx";
import { PagesTable } from "./PagesTable.jsx";
import { PerformanceTable } from "./PerformanceTable.jsx";
import { isLighthouseFailure } from "./filterLogic.js";
import { exportIssues, exportPages, exportPerformance } from "./export.js";
import {
  Alert,
  BotProtectionAdvice,
  ExportMenu,
  SCORE_TEXT_CLASS,
  scoreTone,
  SeverityBadge,
} from "./shared.jsx";

export function ResultsView({ data, tab, onTabChange, siteBlocked, onOpenIssues }) {
  const { audit, pages, issues, lighthouse } = data;

  const crawlStopped = issues.some(
    (issue) => issue.issueType === "crawl-rate-limited",
  );
  const hasPerformanceTab = lighthouse.length > 0;
  const activeTab = tab === "performance" && !hasPerformanceTab ? "issues" : tab;

  const blockedCount = useMemo(
    () => pages.filter((page) => page.fetchClass === "blocked").length,
    [pages],
  );
  const rateLimitedCount = useMemo(
    () => pages.filter((page) => page.fetchClass === "rate_limited").length,
    [pages],
  );
  const hasShells = issues.some(
    (issue) => issue.issueType === "javascript-rendering-suspected",
  );
  // Shopify's own crawler-access signature is the real fix for a throttled or
  // refused crawl there, so it replaces the generic advice for those stores.
  const shopifyLimited =
    audit.config.sitePlatform === "shopify" &&
    (blockedCount > 0 || rateLimitedCount > 0 || crawlStopped);

  const stats = useResultStats(pages, lighthouse);
  const severityCounts = useMemo(() => {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const issue of issues) counts[resolveIssueSeverity(issue)] += 1;
    return counts;
  }, [issues]);

  const tabs = (
    <div className="tabs tabs-inset">
      <button
        type="button"
        className={activeTab === "issues" ? "active" : ""}
        onClick={() => onTabChange("issues")}
      >
        Issues ({issues.length})
      </button>
      <button
        type="button"
        className={activeTab === "pages" ? "active" : ""}
        onClick={() => onTabChange("pages")}
      >
        Pages ({pages.length})
      </button>
      {hasPerformanceTab && (
        <button
          type="button"
          className={activeTab === "performance" ? "active" : ""}
          onClick={() => onTabChange("performance")}
        >
          Performance ({lighthouse.length})
        </button>
      )}
      <span className="spacer" />
      <ExportMenu
        onExport={(format) => {
          if (activeTab === "performance") {
            exportPerformance(lighthouse, pages, format);
          } else if (activeTab === "issues") {
            exportIssues(issues, format);
          } else {
            exportPages(pages, format);
          }
        }}
      />
    </div>
  );

  return (
    <>
      {shopifyLimited && (
        <Alert
          tone="warning"
          title="This Shopify store throttled or refused our crawler."
        >
          Shopify rate limits unknown crawlers. In your admin, go to Online Store
          → Preferences → Crawler access and allow this crawler, then run the
          audit again.
        </Alert>
      )}

      {!shopifyLimited && !siteBlocked && blockedCount > 0 && (
        <Alert
          tone="warning"
          title={`Bot protection blocked our crawler on ${blockedCount} ${blockedCount === 1 ? "page" : "pages"}.`}
        >
          <BotProtectionAdvice />
        </Alert>
      )}

      {!shopifyLimited && (rateLimitedCount > 0 || crawlStopped) && (
        <Alert
          tone="warning"
          title={
            crawlStopped
              ? "The crawl stopped early because of the site's rate limit."
              : `The site rate limited us on ${rateLimitedCount} ${rateLimitedCount === 1 ? "page" : "pages"}.`
          }
        >
          {crawlStopped
            ? "The requested cooldown exceeded the audit time limit, so some URLs were left unvisited. This report is incomplete. "
            : "Pages that returned 429 Too Many Requests could not be audited. "}
          Re-run the audit after the rate limit resets, or ask the site owner to
          allow the "SiteAudit" crawler.
        </Alert>
      )}

      {hasShells && (
        <Alert
          tone="warning"
          title="Some pages may need JavaScript to show their content."
        >
          Their HTML is an empty app shell, so content checks were skipped for
          them. This audit reads server-rendered HTML only.
        </Alert>
      )}

      <StatsStrip
        pagesCrawled={audit.pagesCrawled}
        issueCount={issues.length}
        severityCounts={severityCounts}
        totalLighthouse={lighthouse.length}
        averageResponseMs={stats.averageResponseMs}
        lighthouseSummary={stats.lighthouseSummary}
        lighthouseCost={audit.lighthouseCost}
      />

      {activeTab === "issues" && <IssuesView issues={issues} tabs={tabs} />}
      {activeTab === "pages" && (
        <PagesTable
          pages={pages}
          startUrl={audit.startUrl}
          issues={issues}
          tabs={tabs}
        />
      )}
      {activeTab === "performance" && (
        <PerformanceTable
          lighthouse={lighthouse}
          pages={pages}
          tabs={tabs}
          onOpenIssues={onOpenIssues}
        />
      )}
    </>
  );
}

function useResultStats(pages, lighthouse) {
  const averageResponseMs = useMemo(() => {
    if (pages.length === 0) return 0;
    const total = pages.reduce((sum, page) => sum + (page.responseTimeMs ?? 0), 0);
    return Math.round(total / pages.length);
  }, [pages]);

  const lighthouseSummary = useMemo(() => {
    const failed = lighthouse.filter(isLighthouseFailure).length;
    const successful = lighthouse.filter((row) => !isLighthouseFailure(row));
    const averageScore = (key) => {
      const values = successful
        .map((row) => row[key])
        .filter((value) => value != null);
      if (values.length === 0) return null;
      return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    };

    return {
      failed,
      avgPerformance: averageScore("performanceScore"),
      avgSeo: averageScore("seoScore"),
      avgAccessibility: averageScore("accessibilityScore"),
    };
  }, [lighthouse]);

  return { averageResponseMs, lighthouseSummary };
}

function scoreClass(score) {
  const tone = scoreTone(score);
  return tone ? SCORE_TEXT_CLASS[tone] : "";
}

function StatsStrip({
  pagesCrawled,
  issueCount,
  severityCounts,
  totalLighthouse,
  averageResponseMs,
  lighthouseSummary,
  lighthouseCost,
}) {
  const items = [
    { label: "Pages crawled", value: String(pagesCrawled) },
    {
      label: "Issues found",
      value: String(issueCount),
      valueClass: issueCount === 0 ? "score-success" : "",
      sub: issueCount > 0 && (
        <span className="stat-badges">
          {["critical", "warning", "info"].map((severity) =>
            severityCounts[severity] > 0 ? (
              <SeverityBadge key={severity} severity={severity} title={severity}>
                {severityCounts[severity]}
              </SeverityBadge>
            ) : null,
          )}
        </span>
      ),
    },
    { label: "Avg response", value: `${averageResponseMs}ms` },
  ];

  if (totalLighthouse > 0) {
    items.push(
      { label: "Lighthouse tests", value: String(totalLighthouse) },
      {
        label: "Avg Lighthouse perf",
        value: lighthouseSummary.avgPerformance ?? "-",
        valueClass: scoreClass(lighthouseSummary.avgPerformance),
      },
      {
        label: "Avg Lighthouse SEO",
        value: lighthouseSummary.avgSeo ?? "-",
        valueClass: scoreClass(lighthouseSummary.avgSeo),
      },
      {
        label: "Avg Lighthouse a11y",
        value: lighthouseSummary.avgAccessibility ?? "-",
        valueClass: scoreClass(lighthouseSummary.avgAccessibility),
      },
      {
        label: "Lighthouse failures",
        value: String(lighthouseSummary.failed),
        valueClass:
          lighthouseSummary.failed > 0 ? "score-danger" : "score-success",
      },
    );
    // Not in OpenSEO, which meters centrally. Self-hosters pay DataForSEO
    // directly, so what the audit spent belongs on the report.
    if (lighthouseCost > 0) {
      items.push({
        label: "Lighthouse cost",
        value: `$${lighthouseCost.toFixed(3)}`,
      });
    }
  }

  return (
    <div className="stats">
      {items.map((item) => (
        <div key={item.label} className="stat">
          <p className="stat-label">{item.label}</p>
          <p className={`stat-value ${item.valueClass ?? ""}`}>{item.value}</p>
          {item.sub ? <div className="stat-sub">{item.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
