import { useMemo, useState } from "react";
import {
  Badge,
  countActiveFilters,
  extractHostname,
  extractPathname,
  FilterPanel,
  HttpStatusBadge,
  RangeFilter,
  ResultsTableToolbar,
  SelectFilter,
  SortableHeader,
  TextFilter,
} from "./shared.jsx";
import {
  EMPTY_PAGES_FILTERS,
  filterPages,
  sortRows,
} from "./filterLogic.js";

/**
 * The host most of the site's real (2xx) pages live on. The start URL's host is
 * only a fallback: audits often start from the apex domain of a site that
 * canonicalizes to www, and prefixing every row with the host is exactly the
 * noise this display is meant to avoid.
 */
function predominantHost(pages, startUrl) {
  const counts = new Map();
  for (const page of pages) {
    if (page.statusCode === null || page.statusCode >= 300) continue;
    const host = extractHostname(page.url);
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best = extractHostname(startUrl);
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Path shown in the URL/redirect cells. Redirect sources on another host (e.g.
 * the apex domain 301ing to www) would otherwise render identically to their
 * target, so include the host whenever it differs from the site's.
 */
function displayPath(url, canonicalHost) {
  const host = extractHostname(url);
  const path = extractPathname(url);
  return host === canonicalHost ? path : host + path;
}

function isRedirect(row) {
  return row.statusCode !== null && row.statusCode >= 300 && row.statusCode < 400;
}

/**
 * Redirects and blocked/errored fetches have no analyzed content — their zero
 * H1/word/image counts are an artifact, not a finding.
 */
function hasAnalyzedContent(row) {
  return row.fetchClass === "ok" && !isRedirect(row);
}

const COLUMNS = [
  { id: "url", label: "URL", value: (row) => row.url },
  { id: "statusCode", label: "Status", value: (row) => row.statusCode },
  { id: "title", label: "Title", value: (row) => row.title },
  { id: "h1Count", label: "H1", value: (row) => row.h1Count },
  { id: "wordCount", label: "Words", value: (row) => row.wordCount },
  { id: "images", label: "Images", value: (row) => row.imagesMissingAlt },
  { id: "responseTimeMs", label: "Speed", value: (row) => row.responseTimeMs },
];

const Empty = () => <span className="muted small">-</span>;

export function PagesTable({ pages, startUrl, issues, tabs }) {
  const [filters, setFilters] = useState(EMPTY_PAGES_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  // URL order reads as a site inventory; status-first would open the table on
  // its most boring rows (redirects) whenever a site has no errors.
  const [sorting, setSorting] = useState({ id: "url", desc: false });

  const canonicalHost = useMemo(
    () => predominantHost(pages, startUrl),
    [pages, startUrl],
  );
  // Red "missing" only when the engine flagged it — a 200 that isn't an HTML
  // document (robots.txt, security.txt) legitimately has no title.
  const missingTitlePageIds = useMemo(
    () =>
      new Set(
        issues
          .filter((issue) => issue.issueType === "missing-title")
          .map((issue) => issue.pageId)
          .filter(Boolean),
      ),
    [issues],
  );

  const filteredPages = useMemo(
    () => filterPages(pages, filters),
    [pages, filters],
  );
  const rows = useMemo(() => {
    const column = COLUMNS.find((item) => item.id === sorting.id);
    return sortRows(filteredPages, column.value, sorting.desc);
  }, [filteredPages, sorting]);

  const activeFilterCount = countActiveFilters(filters, EMPTY_PAGES_FILTERS);
  const resetFilters = () => setFilters(EMPTY_PAGES_FILTERS);
  const toggleSort = (id) =>
    setSorting((current) =>
      current.id === id ? { id, desc: !current.desc } : { id, desc: false },
    );

  return (
    <div className="panel">
      {tabs}
      <ResultsTableToolbar
        showFilters={showFilters}
        onToggle={() => setShowFilters((value) => !value)}
        activeFilterCount={activeFilterCount}
        resultCount={rows.length}
        totalCount={pages.length}
      />
      {showFilters ? (
        <PagesFilterBar
          filters={filters}
          onChange={setFilters}
          activeFilterCount={activeFilterCount}
          onReset={resetFilters}
        />
      ) : null}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column.id}>
                  <SortableHeader
                    label={column.label}
                    columnId={column.id}
                    sorting={sorting}
                    onSort={toggleSort}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="cell-url">
                  <a href={row.url} target="_blank" rel="noreferrer" title={row.url}>
                    {displayPath(row.url, canonicalHost)}
                  </a>
                </td>
                <td>
                  {row.fetchClass === "error" ? (
                    <Badge
                      tone="danger"
                      size="sm"
                      title="Fetching failed, so this page was not checked for content issues."
                    >
                      Failed
                    </Badge>
                  ) : (
                    <HttpStatusBadge code={row.statusCode} />
                  )}
                </td>
                <td className="cell-title">
                  {isRedirect(row) ? (
                    <span className="muted small">
                      →{" "}
                      {row.redirectUrl
                        ? displayPath(row.redirectUrl, canonicalHost)
                        : "redirect"}
                    </span>
                  ) : row.title ? (
                    <span>{row.title}</span>
                  ) : missingTitlePageIds.has(row.id) ? (
                    <span className="danger small">missing</span>
                  ) : (
                    <Empty />
                  )}
                </td>
                <td>{hasAnalyzedContent(row) ? row.h1Count : <Empty />}</td>
                <td>{hasAnalyzedContent(row) ? row.wordCount : <Empty />}</td>
                <td>
                  {!hasAnalyzedContent(row) ? (
                    <Empty />
                  ) : row.imagesMissingAlt > 0 ? (
                    <span className="warn">
                      {row.imagesMissingAlt}/{row.imagesTotal}
                    </span>
                  ) : (
                    row.imagesTotal
                  )}
                </td>
                <td>
                  {row.responseTimeMs ? (
                    <span className="small">{row.responseTimeMs}ms</span>
                  ) : (
                    <Empty />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="empty">
            <p className="empty-title">No pages crawled</p>
            {activeFilterCount > 0 && (
              <button type="button" className="link" onClick={resetFilters}>
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PagesFilterBar({ filters, onChange, activeFilterCount, onReset }) {
  const set = (key) => (value) => onChange({ ...filters, [key]: value });

  return (
    <FilterPanel activeCount={activeFilterCount} onReset={onReset}>
      <div className="filter-grid">
        <TextFilter
          label="Search"
          value={filters.query}
          placeholder="URL, title, meta"
          onChange={set("query")}
        />
        <SelectFilter
          label="Status"
          value={filters.status}
          onChange={set("status")}
          options={[
            ["all", "All"],
            ["ok", "2xx"],
            ["redirect", "3xx"],
            ["error", "4xx/5xx"],
            ["missing", "Missing"],
          ]}
        />
        <SelectFilter
          label="Crawl result"
          value={filters.fetchClass}
          onChange={set("fetchClass")}
          options={[
            ["all", "All"],
            ["ok", "Read"],
            ["error", "Failed"],
            ["blocked", "Blocked"],
            ["rate_limited", "Rate limited"],
          ]}
        />
        <SelectFilter
          label="Alt text"
          value={filters.missingAlt}
          onChange={set("missingAlt")}
          options={[
            ["all", "All"],
            ["yes", "Missing alt"],
            ["no", "No missing alt"],
          ]}
        />
      </div>
      <div className="filter-grid filter-grid-2">
        <RangeFilter
          label="Words"
          min={filters.minWords}
          max={filters.maxWords}
          onMinChange={set("minWords")}
          onMaxChange={set("maxWords")}
        />
        <RangeFilter
          label="Speed ms"
          min={filters.minResponseMs}
          max={filters.maxResponseMs}
          onMinChange={set("minResponseMs")}
          onMaxChange={set("maxResponseMs")}
        />
      </div>
    </FilterPanel>
  );
}
