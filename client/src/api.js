import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Where the API lives, relative to wherever this page is mounted.
 *
 * A bare "/api" breaks behind a proxy that serves the app under a path prefix
 * (code-server's port proxy uses /<workspace-id>-<port>/): the browser would
 * ask the proxy root for /api/..., above the prefix, and get the proxy's 404.
 * Deriving it from the current path keeps one build working at the server root
 * and under any prefix.
 */
const API_BASE = (() => {
  let dir = window.location.pathname;
  // Served as a directory, so drop a filename if one is present and make sure
  // the path ends in a slash before anything is resolved against it.
  dir = dir.replace(/[^/]*$/, "");
  return `${dir}api`;
})();

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return body;
}

export const api = {
  getCapabilities: () => request("/capabilities"),
  listAudits: () => request("/audits"),
  startAudit: (startUrl, maxPages, lighthouseStrategy) =>
    request("/audits", {
      method: "POST",
      body: JSON.stringify({ startUrl, maxPages, lighthouseStrategy }),
    }),
  getStatus: (id) => request(`/audits/${id}`),
  getResults: (id) => request(`/audits/${id}/results`),
  getProgress: (id) => request(`/audits/${id}/progress`),
  getLighthouseIssues: (resultId) => request(`/lighthouse/${resultId}/issues`),
  deleteAudit: (id) => request(`/audits/${id}`, { method: "DELETE" }),
};

/**
 * Fetch on mount and, optionally, on an interval. `intervalMs` may be a
 * function of the latest data, so a view can poll a running audit every few
 * seconds and stop the moment it finishes.
 */
export function useFetch(fetcher, deps, { intervalMs, enabled = true } = {}) {
  const [state, setState] = useState({
    data: undefined,
    error: null,
    isPending: true,
  });
  // The fetcher is an inline arrow in every caller; keeping it in a ref means
  // the effect re-runs on `deps` only, not on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    try {
      const data = await fetcherRef.current();
      setState({ data, error: null, isPending: false });
      return data;
    } catch (error) {
      setState((current) => ({ ...current, error, isPending: false }));
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: null, isPending: false });
      return;
    }
    let timer;
    let cancelled = false;

    const tick = async () => {
      const data = await load();
      if (cancelled) return;
      const delay =
        typeof intervalMs === "function" ? intervalMs(data) : intervalMs;
      if (delay) timer = setTimeout(tick, delay);
    };

    setState((current) => ({ ...current, isPending: true }));
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, enabled]);

  return { ...state, refetch: load };
}
