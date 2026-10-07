/**
 * HTTP server: the audit API, plus the built client in production.
 */
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failOrphanedAudits } from "./db.js";
import * as audits from "./audit/service.js";
import { basicAuth, isAuthEnabled } from "./auth.js";
import { describeAllowList } from "./audit/urlPolicy.js";
import { AUDIT_ISSUE_TYPES } from "../shared/auditIssues.js";

const PORT = Number(process.env.PORT ?? 31302);
// Bind to loopback unless told otherwise: a crawler that will fetch any URL it
// is given should not become reachable on every interface by default.
const HOST = process.env.HOST ?? "127.0.0.1";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

failOrphanedAudits();

const app = express();
app.use(express.json());
app.use(basicAuth);

/** Keeps every handler free of try/catch around the service layer. */
const route = (handler) => (req, res) => {
  Promise.resolve(handler(req, res))
    .then((body) => {
      if (!res.headersSent) res.json(body);
    })
    .catch((error) => {
      const status = error?.status ?? 500;
      if (status >= 500) console.error(error);
      res.status(status).json({ error: error?.message ?? "Unexpected error." });
    });
};

app.get("/api/issue-types", route(() => AUDIT_ISSUE_TYPES));

app.get("/api/capabilities", route(() => audits.getCapabilities()));

app.get("/api/audits", route(() => audits.getHistory()));

app.post(
  "/api/audits",
  route((req) =>
    audits.startAudit({
      startUrl: req.body?.startUrl,
      maxPages: req.body?.maxPages,
      lighthouseStrategy: req.body?.lighthouseStrategy,
    }),
  ),
);

app.get("/api/audits/:id", route((req) => audits.getStatus(req.params.id)));

app.get(
  "/api/audits/:id/results",
  route((req) => audits.getResults(req.params.id)),
);

app.get(
  "/api/lighthouse/:resultId/issues",
  route((req) => audits.getLighthouseIssues(req.params.resultId)),
);

app.get(
  "/api/audits/:id/progress",
  route((req) => audits.getCrawlProgress(req.params.id)),
);

app.delete(
  "/api/audits/:id",
  route((req) => {
    audits.removeAudit(req.params.id);
    return { success: true };
  }),
);

// In production the client is served from the same origin; in development
// Vite serves it on :5173 and proxies /api here.
const clientDist = join(rootDir, "client", "dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(join(clientDist, "index.html")));
}

app.listen(PORT, HOST, () => {
  console.log(`Site audit listening on http://${HOST}:${PORT}`);
  console.log(`Auth: ${isAuthEnabled ? "on (basic)" : "OFF — anyone who can reach this port can run crawls"}`);
  const allowList = describeAllowList();
  if (allowList) console.log(`SSRF policy: ${allowList}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && !isAuthEnabled) {
    console.warn(
      "WARNING: bound beyond loopback with no auth. Set AUTH_USER and AUTH_PASSWORD.",
    );
  }
  if (!existsSync(clientDist)) {
    console.log("Run `npm run dev` for the UI, or `npm run build` to serve it from here.");
  }
});
