import { useMemo, useState } from "react";
import {
  getIssueDescriptor,
  ISSUE_SEVERITY_ORDER,
} from "@shared/auditIssues.js";
import { EmptyState, SeverityBadge } from "./shared.jsx";

const MAX_RENDERED_URLS = 100;

const SEVERITY_LABEL = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export function resolveIssueSeverity(issue) {
  const descriptor = getIssueDescriptor(issue.issueType);
  if (descriptor) return descriptor.severity;
  return issue.severity === "critical" || issue.severity === "warning"
    ? issue.severity
    : "info";
}

function groupIssues(issues) {
  const groups = new Map();
  for (const issue of issues) {
    let group = groups.get(issue.issueType);
    if (!group) {
      const descriptor = getIssueDescriptor(issue.issueType);
      group = {
        issueType: issue.issueType,
        severity: resolveIssueSeverity(issue),
        title: descriptor?.title ?? issue.issueType,
        explanation: descriptor?.explanation ?? "",
        howToFix: descriptor?.howToFix ?? "",
        issues: [],
      };
      groups.set(issue.issueType, group);
    }
    group.issues.push(issue);
  }

  return Array.from(groups.values()).sort(
    (a, b) =>
      ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
      b.issues.length - a.issues.length,
  );
}

export function IssuesView({ issues, tabs }) {
  const groups = useMemo(() => groupIssues(issues), [issues]);

  const sections = useMemo(
    () =>
      ["critical", "warning", "info"]
        .map((severity) => ({
          severity,
          groups: groups.filter((group) => group.severity === severity),
        }))
        .filter((section) => section.groups.length > 0),
    [groups],
  );

  return (
    <div className="panel">
      {tabs}
      {issues.length === 0 ? (
        <EmptyState
          title="No issues recorded for this audit."
          description="Either the site is in great shape, or nothing it served could be analyzed — check the Pages tab."
        />
      ) : (
        sections.map((section) => (
          <IssueSection key={section.severity} section={section} />
        ))
      )}
    </div>
  );
}

function IssueSection({ section }) {
  const issueCount = section.groups.reduce(
    (sum, group) => sum + group.issues.length,
    0,
  );

  return (
    <div className="issue-section">
      <div className="issue-section-header">
        <SeverityBadge severity={section.severity}>
          {SEVERITY_LABEL[section.severity]}{" "}
          <span className="tabular">{issueCount}</span>
        </SeverityBadge>
      </div>
      {section.groups.map((group) => (
        <IssueRow key={group.issueType} group={group} />
      ))}
    </div>
  );
}

function IssueRow({ group }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`issue-row severity-${group.severity} ${open ? "open" : ""}`}>
      <button
        type="button"
        className="issue-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="issue-title">{group.title}</span>
        <span className="muted tabular small">
          {group.issues.length} {group.issues.length === 1 ? "page" : "pages"}
        </span>
        <span className={`chevron ${open ? "rotated" : ""}`}>›</span>
      </button>

      {open && (
        <div className="issue-body">
          {group.explanation && <p className="muted">{group.explanation}</p>}
          {group.howToFix && (
            <p>
              <strong>How to fix: </strong>
              {group.howToFix}
            </p>
          )}
          <AffectedUrlList issues={group.issues} />
        </div>
      )}
    </div>
  );
}

function AffectedUrlList({ issues }) {
  const rendered = issues.slice(0, MAX_RENDERED_URLS);
  const remaining = issues.length - rendered.length;

  return (
    <div className="url-list">
      {rendered.map((issue) => (
        <div key={issue.id} className="url-list-row">
          <a href={issue.pageUrl} target="_blank" rel="noreferrer">
            {issue.pageUrl}
          </a>
          <IssueDetails detailsJson={issue.detailsJson} />
        </div>
      ))}
      {remaining > 0 && (
        <div className="url-list-row muted small">
          …and {remaining} more — export the issues CSV for the full list.
        </div>
      )}
    </div>
  );
}

function IssueDetails({ detailsJson }) {
  const entries = useMemo(() => {
    if (!detailsJson) return null;
    // The repository is the only writer and always stores JSON.stringify of a
    // details object, so this parse cannot throw.
    const parsed = JSON.parse(detailsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return Object.entries(parsed).filter(
      ([, value]) => value !== null && value !== undefined,
    );
  }, [detailsJson]);

  if (!entries || entries.length === 0) return null;

  return (
    <span className="muted small">
      {entries
        .map(
          ([key, value]) =>
            `${key}: ${Array.isArray(value) ? value.join(" → ") : String(value)}`,
        )
        .join(" · ")}
    </span>
  );
}
