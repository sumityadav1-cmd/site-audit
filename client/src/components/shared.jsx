import { scoreTone } from "@shared/lighthouse.js";

export function extractPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** SQLite stores UTC without a zone marker; tell Date so it isn't read local. */
function toDate(dateStr) {
  return new Date(dateStr.replace(" ", "T") + "Z");
}

export function formatDate(dateStr) {
  return toDate(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatStartedAt(dateStr) {
  return toDate(dateStr).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatScannedAt(dateStr) {
  return toDate(dateStr).toLocaleString();
}

export function Badge({ tone = "default", children, title, size }) {
  return (
    <span
      className={`badge badge-${tone}${size === "sm" ? " badge-sm" : ""}`}
      title={title}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }) {
  if (status === "running") {
    return (
      <Badge tone="info">
        <Spinner /> Running
      </Badge>
    );
  }
  if (status === "completed") return <Badge tone="success">Done</Badge>;
  return <Badge tone="danger">Failed</Badge>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

export function HttpStatusBadge({ code }) {
  if (!code) return <Badge tone="muted">-</Badge>;
  const tone =
    code >= 200 && code < 300
      ? "success"
      : code >= 300 && code < 400
        ? "warning"
        : "danger";
  return <Badge tone={tone}>{code}</Badge>;
}

export const SCORE_TEXT_CLASS = {
  success: "score-success",
  warning: "score-warning",
  danger: "score-danger",
};

export { scoreTone };

export function LighthouseScoreBadge({ score }) {
  const tone = scoreTone(score);
  if (tone == null) return <span className="muted small">-</span>;
  return <span className={`score ${SCORE_TEXT_CLASS[tone]}`}>{score}</span>;
}

const SEVERITY_TONE = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

/** The one way audit and Lighthouse pages show an issue severity. */
export function SeverityBadge({ severity, children, title }) {
  return (
    <Badge tone={SEVERITY_TONE[severity] ?? "muted"} title={title}>
      {children}
    </Badge>
  );
}

export function Alert({ tone = "warning", title, children }) {
  return (
    <div className={`alert alert-${tone}`}>
      <strong>{title}</strong>
      {children ? <div className="alert-body">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, description }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {description ? <p className="muted small">{description}</p> : null}
    </div>
  );
}

/** What to do when a site's bot protection blocked the crawler. */
export function BotProtectionAdvice() {
  return (
    <>
      If you own this site, allowlist the "SiteAudit" user agent in your
      WAF/bot-protection settings, then re-run the audit. Otherwise, try a free
      desktop crawler like{" "}
      <a
        href="https://github.com/PhialsBasement/LibreCrawl"
        target="_blank"
        rel="noreferrer"
      >
        LibreCrawl
      </a>{" "}
      or{" "}
      <a
        href="https://www.screamingfrog.co.uk/seo-spider/"
        target="_blank"
        rel="noreferrer"
      >
        Screaming Frog
      </a>
      .
    </>
  );
}

/** The toolbar above a results table: the filter toggle and the row count. */
export function ResultsTableToolbar({
  showFilters,
  onToggle,
  activeFilterCount,
  resultCount,
  totalCount,
}) {
  return (
    <div className="table-toolbar">
      <button
        type="button"
        className={showFilters ? "active" : ""}
        onClick={onToggle}
      >
        Filters
        {activeFilterCount > 0 ? (
          <Badge tone="info" size="sm">
            {activeFilterCount}
          </Badge>
        ) : null}
      </button>
      <span className="spacer" />
      <span className="muted tabular small">
        {resultCount.toLocaleString()} of {totalCount.toLocaleString()}
      </span>
    </div>
  );
}

export function FilterPanel({ activeCount, onReset, children }) {
  return (
    <div className="filter-panel">
      {children}
      {activeCount > 0 ? (
        <button type="button" className="link" onClick={onReset}>
          Reset {activeCount} filter{activeCount === 1 ? "" : "s"}
        </button>
      ) : null}
    </div>
  );
}

export function FilterGroup({ label, children }) {
  return (
    <label className="filter-group">
      <span className="filter-label">{label}</span>
      {children}
    </label>
  );
}

export function SelectFilter({ label, value, options, onChange }) {
  return (
    <FilterGroup label={label}>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </FilterGroup>
  );
}

export function TextFilter({ label, value, placeholder, type = "text", onChange }) {
  return (
    <FilterGroup label={label}>
      <input
        aria-label={label}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </FilterGroup>
  );
}

export function RangeFilter({ label, min, max, onMinChange, onMaxChange }) {
  return (
    <FilterGroup label={label}>
      <span className="range-inputs">
        <input
          aria-label={`${label} min`}
          type="number"
          placeholder="min"
          value={min}
          onChange={(event) => onMinChange(event.target.value)}
        />
        <span className="muted">–</span>
        <input
          aria-label={`${label} max`}
          type="number"
          placeholder="max"
          value={max}
          onChange={(event) => onMaxChange(event.target.value)}
        />
      </span>
    </FilterGroup>
  );
}

export function countActiveFilters(filters, emptyFilters) {
  return Object.keys(filters).reduce(
    (count, key) => (filters[key] !== emptyFilters[key] ? count + 1 : count),
    0,
  );
}

/** Column headers that sort on click. */
export function SortableHeader({ label, columnId, sorting, onSort }) {
  const active = sorting.id === columnId;
  return (
    <button type="button" onClick={() => onSort(columnId)}>
      {label}
      {active ? (sorting.desc ? " ↓" : " ↑") : ""}
    </button>
  );
}

export function ExportMenu({ onExport }) {
  return (
    <span className="export-menu">
      <button type="button" onClick={() => onExport("csv")}>
        Export CSV
      </button>
      <button type="button" onClick={() => onExport("json")}>
        JSON
      </button>
    </span>
  );
}
