import { useState } from "react";
import { api, useFetch } from "../api.js";
import {
  DEFAULT_AUDIT_PAGES,
  MAX_AUDIT_PAGES,
  MIN_AUDIT_PAGES,
} from "@shared/auditLimits.js";
import { Alert, Badge, EmptyState, formatDate, StatusBadge } from "./shared.jsx";

/** Above this, warn before starting — a big crawl takes a while. */
const LARGE_CRAWL_PAGES = 1_000;

function clampMaxPages(input) {
  const value = input ? Number.parseInt(input, 10) : MIN_AUDIT_PAGES;
  return Number.isFinite(value)
    ? Math.max(MIN_AUDIT_PAGES, Math.min(MAX_AUDIT_PAGES, Math.round(value)))
    : MIN_AUDIT_PAGES;
}

export function LaunchView({ onOpenAudit }) {
  const [url, setUrl] = useState("");
  const [maxPagesInput, setMaxPagesInput] = useState(String(DEFAULT_AUDIT_PAGES));
  const [runLighthouse, setRunLighthouse] = useState(false);
  const [error, setError] = useState(null);
  const [isStarting, setIsStarting] = useState(false);

  const capabilitiesQuery = useFetch(() => api.getCapabilities(), []);
  const canRunLighthouse = capabilitiesQuery.data?.canRunLighthouse === true;
  const sampleLimit = capabilitiesQuery.data?.lighthouseSampleLimit ?? 10;

  const historyQuery = useFetch(() => api.listAudits(), [], {
    // Keep the list fresh while an audit on it is running.
    intervalMs: (data) =>
      data?.some((audit) => audit.status === "running") ? 3000 : null,
  });

  const maxPages = clampMaxPages(maxPagesInput);

  const submit = async (event) => {
    event.preventDefault();
    if (isStarting) return;
    if (
      maxPages >= LARGE_CRAWL_PAGES &&
      !window.confirm(
        `You are about to crawl ${maxPages.toLocaleString()} pages. This is okay, but it may take a while. Continue?`,
      )
    ) {
      return;
    }

    setError(null);
    setIsStarting(true);
    try {
      const { auditId } = await api.startAudit(
        url,
        maxPages,
        runLighthouse && canRunLighthouse ? "auto" : "none",
      );
      onOpenAudit(auditId);
    } catch (startError) {
      setError(startError.message);
    } finally {
      setIsStarting(false);
    }
  };

  const remove = async (auditId) => {
    if (!window.confirm("Delete this audit and all of its results?")) return;
    try {
      await api.deleteAudit(auditId);
      await historyQuery.refetch();
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  return (
    <>
      <h1>Site Audit</h1>

      <div className="panel">
        <div className="panel-header">
          <h2>Start New Audit</h2>
        </div>
        <form className="launch-form" onSubmit={submit}>
          <div className="launch-row">
            <input
              type="text"
              aria-label="Site URL"
              placeholder="https://example.com"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              required
            />
            <button type="submit" className="primary" disabled={isStarting}>
              {isStarting ? "Starting..." : "Start Audit"}
            </button>
          </div>

          <div className="launch-options">
            <fieldset className="option">
              <label htmlFor="audit-max-pages">Max pages</label>
              <input
                id="audit-max-pages"
                type="number"
                min={MIN_AUDIT_PAGES}
                max={MAX_AUDIT_PAGES}
                value={maxPagesInput}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!/^\d*$/.test(next)) return;
                  setMaxPagesInput(next);
                  setError(null);
                }}
                onBlur={() => setMaxPagesInput(String(maxPages))}
              />
              <p className="option-description">
                Enter any value from {MIN_AUDIT_PAGES} to{" "}
                {MAX_AUDIT_PAGES.toLocaleString()}.
              </p>
            </fieldset>

            <fieldset className="option">
              <label
                className="switch-label"
                title="Lighthouse measures the performance of your pages and identifies issues."
              >
                <input
                  type="checkbox"
                  role="switch"
                  checked={runLighthouse && canRunLighthouse}
                  disabled={!canRunLighthouse}
                  onChange={(event) => setRunLighthouse(event.target.checked)}
                />
                Include Lighthouse
              </label>
              {canRunLighthouse ? (
                runLighthouse ? (
                  <p className="option-description">
                    We choose a sample of up to {sampleLimit} pages to audit,
                    removing pages from duplicate templates. Each page is checked
                    on mobile and desktop, and DataForSEO bills per check.
                  </p>
                ) : null
              ) : (
                <p className="option-description">
                  Lighthouse needs a DataForSEO API key. Set{" "}
                  <code>DATAFORSEO_API_KEY</code>, restart the server, then reload
                  this page.
                </p>
              )}
            </fieldset>
          </div>
        </form>

        {error && (
          <div className="panel-footer">
            <Alert tone="danger" title={error} />
          </div>
        )}
      </div>

      {historyQuery.isPending && !historyQuery.data ? (
        <p className="muted">Loading…</p>
      ) : historyQuery.data?.length ? (
        <div className="panel">
          <div className="panel-header">
            <h2>Previous Audits</h2>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Pages</th>
                  <th>Lighthouse</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.map((audit) => (
                  <tr key={audit.id}>
                    <td className="muted small">{formatDate(audit.startedAt)}</td>
                    <td className="cell-url">{audit.startUrl}</td>
                    <td>
                      <StatusBadge status={audit.status} />
                    </td>
                    <td className="tabular">
                      {audit.pagesTotal || audit.pagesCrawled}
                    </td>
                    <td>
                      {audit.ranLighthouse ? (
                        <Badge tone="muted" size="sm">
                          Yes
                        </Badge>
                      ) : null}
                    </td>
                    <td className="row-actions">
                      <button type="button" onClick={() => onOpenAudit(audit.id)}>
                        View
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        onClick={() => remove(audit.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState title="No audits yet" description="Run one above." />
      )}
    </>
  );
}
