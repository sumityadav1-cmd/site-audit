import { useMemo, useState } from "react";
import {
  Badge,
  countActiveFilters,
  extractPathname,
  FilterPanel,
  LighthouseScoreBadge,
  RangeFilter,
  ResultsTableToolbar,
  SelectFilter,
  SortableHeader,
  TextFilter,
} from "./shared.jsx";
import {
  EMPTY_PERFORMANCE_FILTERS,
  filterPerformanceRows,
  isLighthouseFailure,
  sortRows,
} from "./filterLogic.js";

const COLUMNS = [
  { id: "pagePath", label: "URL", value: (row) => row.pagePath },
  { id: "strategy", label: "Device", value: (row) => row.strategy },
  {
    id: "status",
    label: "Status",
    value: (row) => Number(isLighthouseFailure(row)),
  },
  { id: "performanceScore", label: "Perf", value: (row) => row.performanceScore },
  {
    id: "accessibilityScore",
    label: "A11y",
    value: (row) => row.accessibilityScore,
  },
  { id: "seoScore", label: "SEO", value: (row) => row.seoScore },
  { id: "lcpMs", label: "LCP", value: (row) => row.lcpMs },
  { id: "cls", label: "CLS", value: (row) => row.cls },
  { id: "inpMs", label: "INP", value: (row) => row.inpMs },
  { id: "ttfbMs", label: "TTFB", value: (row) => row.ttfbMs },
  { id: "issues", label: "Issues", value: () => null, sortable: false },
];

const Empty = () => <span className="muted small">-</span>;

export function PerformanceTable({ lighthouse, pages, tabs, onOpenIssues }) {
  const [filters, setFilters] = useState(EMPTY_PERFORMANCE_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [sorting, setSorting] = useState({ id: "performanceScore", desc: false });

  const allRows = useMemo(
    () =>
      lighthouse.map((result) => {
        const page = pages.find((candidate) => candidate.id === result.pageId);
        const pageUrl = page?.url ?? null;
        return {
          ...result,
          pageUrl,
          pagePath: pageUrl ? extractPathname(pageUrl) : null,
        };
      }),
    [lighthouse, pages],
  );

  const filteredRows = useMemo(
    () => filterPerformanceRows(allRows, filters),
    [allRows, filters],
  );
  const rows = useMemo(() => {
    const column = COLUMNS.find((item) => item.id === sorting.id);
    return sortRows(filteredRows, column.value, sorting.desc);
  }, [filteredRows, sorting]);

  const activeFilterCount = countActiveFilters(
    filters,
    EMPTY_PERFORMANCE_FILTERS,
  );
  const resetFilters = () => setFilters(EMPTY_PERFORMANCE_FILTERS);
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
        totalCount={allRows.length}
      />
      {showFilters ? (
        <PerformanceFilterBar
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
                  {column.sortable === false ? (
                    column.label
                  ) : (
                    <SortableHeader
                      label={column.label}
                      columnId={column.id}
                      sorting={sorting}
                      onSort={toggleSort}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const failed = isLighthouseFailure(row);
              return (
                <tr key={row.id}>
                  <td className="cell-url small" title={row.pageUrl ?? undefined}>
                    {row.pagePath ?? "-"}
                  </td>
                  <td className="small capitalize">{row.strategy}</td>
                  <td>
                    {failed ? (
                      <Badge
                        tone="danger"
                        title={
                          row.errorMessage ??
                          "Lighthouse returned no category scores"
                        }
                      >
                        failed
                      </Badge>
                    ) : (
                      <Badge tone="success">ok</Badge>
                    )}
                  </td>
                  <td>
                    <LighthouseScoreBadge score={row.performanceScore} />
                  </td>
                  <td>
                    <LighthouseScoreBadge score={row.accessibilityScore} />
                  </td>
                  <td>
                    <LighthouseScoreBadge score={row.seoScore} />
                  </td>
                  <td className="small">
                    {row.lcpMs ? `${(row.lcpMs / 1000).toFixed(1)}s` : <Empty />}
                  </td>
                  <td className="small">
                    {row.cls != null ? row.cls.toFixed(3) : <Empty />}
                  </td>
                  <td className="small">
                    {row.inpMs ? `${Math.round(row.inpMs)}ms` : <Empty />}
                  </td>
                  <td className="small">
                    {row.ttfbMs ? `${Math.round(row.ttfbMs)}ms` : <Empty />}
                  </td>
                  <td>
                    {row.payloadSizeBytes && !failed ? (
                      <button type="button" onClick={() => onOpenIssues(row.id)}>
                        View issues
                      </button>
                    ) : (
                      <Empty />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="empty">
            <p className="empty-title">No Lighthouse results</p>
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

function PerformanceFilterBar({ filters, onChange, activeFilterCount, onReset }) {
  const set = (key) => (value) => onChange({ ...filters, [key]: value });

  return (
    <FilterPanel activeCount={activeFilterCount} onReset={onReset}>
      <div className="filter-grid">
        <TextFilter
          label="Search"
          value={filters.query}
          placeholder="URL"
          onChange={set("query")}
        />
        <SelectFilter
          label="Device"
          value={filters.device}
          onChange={set("device")}
          options={[
            ["all", "All"],
            ["desktop", "Desktop"],
            ["mobile", "Mobile"],
          ]}
        />
        <SelectFilter
          label="Status"
          value={filters.status}
          onChange={set("status")}
          options={[
            ["all", "All"],
            ["ok", "OK"],
            ["failed", "Failed"],
          ]}
        />
        <TextFilter
          label="Max LCP s"
          value={filters.maxLcpSeconds}
          placeholder="2.5"
          type="number"
          onChange={set("maxLcpSeconds")}
        />
      </div>
      <div className="filter-grid filter-grid-2">
        <RangeFilter
          label="Perf"
          min={filters.minPerf}
          max={filters.maxPerf}
          onMinChange={set("minPerf")}
          onMaxChange={set("maxPerf")}
        />
        <RangeFilter
          label="SEO"
          min={filters.minSeo}
          max={filters.maxSeo}
          onMinChange={set("minSeo")}
          onMaxChange={set("maxSeo")}
        />
      </div>
    </FilterPanel>
  );
}
