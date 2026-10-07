/**
 * HTTP Basic auth.
 *
 * Off by default (local use). Set AUTH_USER and AUTH_PASSWORD to turn it on.
 *
 * This exists because of what the app is: anyone who can reach it can make
 * this server issue HTTP requests to any URL they name, from this server's IP
 * and inside whatever network it sits in. Unauthenticated and reachable from
 * the internet, that is an open SSRF proxy — more so when ALLOW_PRIVATE_HOSTS
 * has opened intranet ranges. Basic auth over TLS is the floor, not a
 * considered access-control design.
 */
import { timingSafeEqual } from "node:crypto";

const USER = process.env.AUTH_USER ?? "";
const PASSWORD = process.env.AUTH_PASSWORD ?? "";

export const isAuthEnabled = Boolean(USER && PASSWORD);

/** Constant-time compare that tolerates differing lengths. */
function matches(received, expected) {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function basicAuth(req, res, next) {
  if (!isAuthEnabled) return next();

  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() === "basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator !== -1) {
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      // Both compared every time, so a wrong username costs the same as a
      // wrong password.
      const userOk = matches(user, USER);
      const passwordOk = matches(password, PASSWORD);
      if (userOk && passwordOk) return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Site Audit", charset="UTF-8"');
  res.status(401).json({ error: "Authentication required." });
}
