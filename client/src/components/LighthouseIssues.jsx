import { useMemo, useState } from "react";
import { api, useFetch } from "../api.js";
import {
  categoryLabel,
  LIGHTHOUSE_CATEGORY_TABS,
  scoreTone,
} from "@shared/lighthouse.js";
import {
  Alert,
  EmptyState,
  formatScannedAt,
  SCORE_TEXT_CLASS,
  SeverityBadge,
} from "./shared.jsx";
import { exportLighthouseIssues } from "./export.js";

export function LighthouseIssuesScreen({ resultId, onBack }) {
  const [category, setCategory] = useState("all");
  const query = useFetch(() => api.getLighthouseIssues(resultId), [resultId]);

  const data = query.data;
  const allIssues = data?.issues ?? [];
  const visibleIssues =
    category === "all"
      ? allIssues
      : allIssues.filter((issue) => issue.category === category);

  const categoryCounts = useMemo(
    () =>
      Object.fromEntries(
        LIGHTHOUSE_CATEGORY_TABS.map((tab) => [
          tab,
          tab === "all"
            ? allIssues.length
            : allIssues.filter((issue) => issue.category === tab).length,
        ]),
      ),
    [allIssues],
  );

  const severityCounts = useMemo(
    () => ({
      critical: visibleIssues.filter((issue) => issue.severity === "critical")
        .length,
      warning: visibleIssues.filter((issue) => issue.severity === "warning")
        .length,
      info: visibleIssues.filter((issue) => issue.severity === "info").length,
    }),
    [visibleIssues],
  );

  // Runs stored before issue details were kept have no issues to list.
  const emptyMessage =
    data != null && !data.hasIssueDetails
      ? "This Lighthouse run was saved without issue details. Re-run the audit to see them."
      : "No issues in this category.";

  return (
    <>
      <div className="detail-top">
        <button type="button" className="link" onClick={onBack}>
          ← Site Audit
        </button>
        <span className="muted small">
          {data?.createdAt
            ? `Scanned ${formatScannedAt(data.createdAt)}`
            : query.isPending
              ? "Reading latest issues…"
              : null}
        </span>
      </div>

      {query.error && (
        <Alert tone="danger" title="Failed to load Lighthouse issues.">
          {query.error.message}
        </Alert>
      )}

      <div className="panel lighthouse-header">
        <h1>Lighthouse Issues</h1>
        <p className="muted break-all">
          {data?.finalUrl ?? (query.isPending ? "Loading URL…" : null)}
          {data?.strategy ? ` · ${data.strategy}` : null}
        </p>

        {data?.scores && (
          <div className="gauges">
            <ScoreGauge label="Performance" score={data.scores.performance} />
            <ScoreGauge label="Accessibility" score={data.scores.accessibility} />
            <ScoreGauge
              label="Best Practices"
              score={data.scores["best-practices"]}
            />
            <ScoreGauge label="SEO" score={data.scores.seo} />
          </div>
        )}

        <MetricsStrip metrics={data?.metrics} />

        <div className="severity-row">
          <SeverityBadge severity="critical">
            Critical {severityCounts.critical}
          </SeverityBadge>
          <SeverityBadge severity="warning">
            Warning {severityCounts.warning}
          </SeverityBadge>
          <SeverityBadge severity="info">Info {severityCounts.info}</SeverityBadge>
        </div>
      </div>

      <div className="panel">
        <div className="tabs tabs-inset">
          {LIGHTHOUSE_CATEGORY_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={category === tab ? "active" : ""}
              onClick={() => setCategory(tab)}
            >
              {categoryLabel(tab)} ({categoryCounts[tab] ?? 0})
            </button>
          ))}
          <span className="spacer" />
          <button
            type="button"
            onClick={() => exportLighthouseIssues(visibleIssues, category, "csv")}
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => exportLighthouseIssues(visibleIssues, category, "json")}
          >
            JSON
          </button>
        </div>

        {query.isPending && !data ? (
          <div className="empty muted">Loading…</div>
        ) : visibleIssues.length === 0 ? (
          <EmptyState title={emptyMessage} />
        ) : (
          <table className="lighthouse-issues">
            <thead>
              <tr>
                <th />
                <th>Severity</th>
                <th>Issue</th>
                <th className="hide-sm">Category</th>
                <th className="hide-md align-right">Impact</th>
                <th className="align-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {visibleIssues.map((issue) => (
                <LighthouseIssueRow key={issue.auditKey} issue={issue} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function LighthouseIssueRow({ issue }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(issue.description || issue.items.length > 0);

  return (
    <>
      <tr
        className={hasDetails ? "clickable" : undefined}
        onClick={() => hasDetails && setOpen(!open)}
      >
        <td>
          {hasDetails ? (
            <span className={`chevron ${open ? "rotated" : ""}`}>›</span>
          ) : null}
        </td>
        <td>
          <SeverityBadge severity={issue.severity}>{issue.severity}</SeverityBadge>
        </td>
        <td>
          <p className="issue-title">{issue.title}</p>
          {issue.displayValue ? (
            <p className="muted small">{issue.displayValue}</p>
          ) : null}
        </td>
        <td className="hide-sm muted small">{issue.category}</td>
        <td className="hide-md align-right muted small tabular">
          {issue.impactMs ? formatMs(issue.impactMs) : null}
          {issue.impactMs && issue.impactBytes ? " / " : null}
          {issue.impactBytes ? formatBytes(issue.impactBytes) : null}
        </td>
        <td className="align-right muted small tabular">{issue.score ?? ""}</td>
      </tr>
      {open ? (
        <tr className="detail-row">
          <td colSpan={6}>
            {issue.description ? (
              <p className="muted">{renderInlineMarkdown(issue.description)}</p>
            ) : null}
            {issue.items.length > 0 ? (
              <details>
                <summary className="muted small">
                  Affected items ({issue.items.length})
                </summary>
                <div className="affected-items">
                  {issue.items.map((item, index) => (
                    <pre key={`${issue.auditKey}-${index}`}>{item}</pre>
                  ))}
                </div>
              </details>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ScoreGauge({ label, score }) {
  const displayScore = score ?? 0;
  const tone = scoreTone(score);
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const progress = (displayScore / 100) * circumference;

  return (
    <div className="gauge">
      <div className="gauge-dial">
        <svg viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="4" className="gauge-track" />
          {tone != null ? (
            <circle
              cx="32"
              cy="32"
              r={radius}
              fill="none"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${progress} ${circumference}`}
              className={`gauge-arc arc-${tone}`}
            />
          ) : null}
        </svg>
        <span className={`gauge-value ${tone ? SCORE_TEXT_CLASS[tone] : "muted"}`}>
          {score ?? "-"}
        </span>
      </div>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

function MetricsStrip({ metrics }) {
  if (!metrics) return null;
  const items = [
    { label: "FCP", value: metrics.firstContentfulPaint.displayValue },
    { label: "LCP", value: metrics.largestContentfulPaint.displayValue },
    { label: "TBT", value: metrics.totalBlockingTime.displayValue },
    { label: "SI", value: metrics.speedIndex.displayValue },
    { label: "TTI", value: metrics.timeToInteractive.displayValue },
    { label: "CLS", value: metrics.cumulativeLayoutShift.displayValue },
    { label: "INP", value: metrics.interactionToNextPaint.displayValue },
    { label: "TTFB", value: metrics.serverResponseTime.displayValue },
  ].filter((metric) => metric.value != null);

  if (items.length === 0) return null;

  return (
    <div className="metrics-strip">
      {items.map((metric) => (
        <div key={metric.label} className="metric">
          <span className="metric-label">{metric.label}</span>
          <span className="metric-value tabular">{metric.value}</span>
        </div>
      ))}
    </div>
  );
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Lighthouse descriptions carry markdown links to the docs for each audit. */
function renderInlineMarkdown(markdown) {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const nodes = [];
  let cursor = 0;
  let match = linkPattern.exec(markdown);

  while (match) {
    const [raw, label, href] = match;
    if (match.index > cursor) nodes.push(markdown.slice(cursor, match.index));
    nodes.push(
      <a key={`${href}-${match.index}`} href={href} target="_blank" rel="noreferrer">
        {label}
      </a>,
    );
    cursor = match.index + raw.length;
    match = linkPattern.exec(markdown);
  }

  if (cursor < markdown.length) nodes.push(markdown.slice(cursor));
  return nodes.length ? nodes : markdown;
}
