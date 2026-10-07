import { useEffect, useState } from "react";
import { LaunchView } from "./components/LaunchView.jsx";
import { AuditDetail } from "./components/AuditDetail.jsx";
import { LighthouseIssuesScreen } from "./components/LighthouseIssues.jsx";

const TABS = ["issues", "pages", "performance"];

/**
 * Routing lives in the hash, so a report survives a refresh and is linkable.
 *   #/audits/<id>?tab=pages
 *   #/audits/<id>/lighthouse/<resultId>
 */
function readRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  const [path, queryString] = hash.split("?");
  const query = new URLSearchParams(queryString ?? "");
  const tab = TABS.includes(query.get("tab")) ? query.get("tab") : "issues";

  const lighthouse = path.match(/^\/audits\/([\w-]+)\/lighthouse\/([\w-]+)$/);
  if (lighthouse) {
    return { view: "lighthouse", auditId: lighthouse[1], resultId: lighthouse[2] };
  }

  const audit = path.match(/^\/audits\/([\w-]+)$/);
  if (audit) return { view: "audit", auditId: audit[1], tab };

  return { view: "launch" };
}

export function App() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const go = (hash) => {
    window.location.hash = hash;
  };

  return (
    <main>
      {route.view === "lighthouse" ? (
        <LighthouseIssuesScreen
          resultId={route.resultId}
          onBack={() => go(`#/audits/${route.auditId}?tab=performance`)}
        />
      ) : route.view === "audit" ? (
        <AuditDetail
          auditId={route.auditId}
          tab={route.tab}
          onTabChange={(tab) => go(`#/audits/${route.auditId}?tab=${tab}`)}
          onBack={() => go("")}
          onOpenIssues={(resultId) =>
            go(`#/audits/${route.auditId}/lighthouse/${resultId}`)
          }
        />
      ) : (
        <LaunchView onOpenAudit={(auditId) => go(`#/audits/${auditId}`)} />
      )}
    </main>
  );
}
