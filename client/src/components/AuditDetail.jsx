import { api, useFetch } from "../api.js";
import { ResultsView } from "./ResultsView.jsx";
import {
  Alert,
  Badge,
  BotProtectionAdvice,
  extractHostname,
  extractPathname,
  formatStartedAt,
  HttpStatusBadge,
  Spinner,
  StatusBadge,
} from "./shared.jsx";

export function AuditDetail({ auditId, tab, onTabChange, onBack, onOpenIssues }) {
  const statusQuery = useFetch(() => api.getStatus(auditId), [auditId], {
    intervalMs: (data) => (data?.status === "running" ? 3000 : null),
  });

  const status = statusQuery.data;
  const isComplete = status?.status === "completed";
  const isFailed = status?.status === "failed";
  const isRunning = status?.status === "running";

  // Failed audits keep whatever pages were crawled before the failure
  // (persistence is per-batch), so fetch results for them too and show the
  // partial crawl instead of a dead end.
  const resultsQuery = useFetch(
    () => api.getResults(auditId),
    [auditId, status?.status],
    { enabled: isComplete || isFailed },
  );

  if (statusQuery.isPending && !status) {
    return <p className="muted">Loading audit…</p>;
  }
  if (statusQuery.error) {
    return (
      <>
        <button type="button" className="link" onClick={onBack}>
          ← All audits
        </button>
        <Alert tone="danger" title="We could not load this audit.">
          It may have been deleted. {statusQuery.error.message}
        </Alert>
      </>
    );
  }

  const results = resultsQuery.data;
  const partialPageCount = isFailed ? (results?.pages.length ?? 0) : 0;
  const failedWithResults = isFailed && partialPageCount > 0;
  // Wait for the results fetch before choosing between the "partial results"
  // banner and the zero-page banner, so the zero-page banner doesn't flash.
  const failedWithoutResults = isFailed && results !== undefined && !failedWithResults;
  // A completed crawl that reached one page or none was blocked by the site,
  // unless that page is an app shell, which the results explain instead. A
  // failed audit stopped on our side, so it gets the error code instead.
  const siteBlocked =
    isComplete &&
    status.pagesCrawled <= 1 &&
    results !== undefined &&
    !results.issues.some(
      (issue) => issue.issueType === "javascript-rendering-suspected",
    );

  return (
    <>
      <button type="button" className="link" onClick={onBack}>
        ← All audits
      </button>

      <header className="detail-header">
        <h1>{extractHostname(status.startUrl)}</h1>
        {!isRunning && <StatusBadge status={status.status} />}
        <p className="muted small">
          Site audit · Started {formatStartedAt(status.startedAt)}
        </p>
      </header>

      {isRunning && <ProgressCard auditId={auditId} status={status} />}

      {failedWithoutResults && (
        <Alert tone="danger" title="This audit stopped before it crawled any pages.">
          Run a new audit to try again.
          {status.errorCode ? <code> Code: {status.errorCode}</code> : null}
        </Alert>
      )}

      {siteBlocked && results && (
        <Alert tone="warning" title="This site's bot protection blocked our crawler.">
          <BotProtectionAdvice />
        </Alert>
      )}

      {failedWithResults && (
        <Alert
          tone="warning"
          title={`This audit stopped early after ${partialPageCount} page${partialPageCount === 1 ? "" : "s"}.`}
        >
          The results below cover everything crawled before it stopped.
          {status.errorCode ? <code> Code: {status.errorCode}</code> : null}
        </Alert>
      )}

      {resultsQuery.error && (
        <Alert tone="danger" title="Failed to load the audit results.">
          {resultsQuery.error.message}
        </Alert>
      )}

      {results && (isComplete || failedWithResults) && (
        <ResultsView
          data={results}
          tab={tab}
          onTabChange={onTabChange}
          siteBlocked={siteBlocked}
          onOpenIssues={onOpenIssues}
        />
      )}
    </>
  );
}

const PHASE_LABEL = {
  discovery: "Discovery",
  crawling: "Crawling",
  lighthouse: "Lighthouse",
  finalizing: "Finalizing",
};

function ProgressCard({ auditId, status }) {
  const isLighthousePhase = status.currentPhase === "lighthouse";

  const progressQuery = useFetch(() => api.getProgress(auditId), [auditId], {
    intervalMs: 1500,
    enabled: !isLighthousePhase,
  });
  const crawledUrls = progressQuery.data ?? [];

  const crawlProgress =
    status.pagesTotal > 0
      ? Math.round((status.pagesCrawled / status.pagesTotal) * 100)
      : 0;
  const lighthouseDone = status.lighthouseCompleted + status.lighthouseFailed;
  const lighthouseProgress =
    status.lighthouseTotal > 0
      ? Math.round((lighthouseDone / status.lighthouseTotal) * 100)
      : 0;
  const percent = isLighthousePhase ? lighthouseProgress : crawlProgress;

  return (
    <>
      <div className="panel progress-card">
        <div className="progress-header">
          <strong>
            <Spinner />{" "}
            {isLighthousePhase ? "Running Lighthouse checks" : "Crawling pages"}
          </strong>
          <Badge tone="muted">
            {PHASE_LABEL[status.currentPhase] ?? "Running"}
          </Badge>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <p className="muted small">
          {isLighthousePhase
            ? `${lighthouseDone} / ${status.lighthouseTotal} checks${
                status.lighthouseFailed > 0
                  ? ` (${status.lighthouseFailed} failed)`
                  : ""
              }`
            : `${status.pagesCrawled} / ${status.pagesTotal} pages`}{" "}
          · {percent}%
        </p>
      </div>

      {crawledUrls.length > 0 && (
        <div className="panel progress-card">
          <div className="progress-header">
            <strong className="muted">
              Crawled Pages ({crawledUrls.length})
            </strong>
            <span className="muted small">
              Updated {new Date(crawledUrls[0].crawledAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="progress-feed">
            {crawledUrls.map((entry, index) => (
              <div
                key={`${entry.url}-${entry.crawledAt}`}
                className={`progress-row ${index === 0 ? "newest" : ""}`}
              >
                <HttpStatusBadge code={entry.statusCode} />
                <span className="progress-path" title={entry.url}>
                  {extractPathname(entry.url)}
                </span>
                {entry.title && (
                  <span className="muted small progress-title">{entry.title}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
