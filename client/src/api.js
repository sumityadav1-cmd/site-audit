import { useCallback, useEffect, useRef, useState } from "react";

async function request(path, options) {
  const response = await fetch(`/api${path}`, {
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
