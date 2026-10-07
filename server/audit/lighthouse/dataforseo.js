/**
 * DataForSEO Lighthouse client.
 *
 * Enabled only when DATAFORSEO_API_KEY is set, so the whole Performance
 * feature is absent rather than broken on a deployment without a key.
 *
 * The key is the base64 of `login:password` from your DataForSEO dashboard —
 * the same string their docs put in `Authorization: Basic ...`. Set
 * DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD instead and we'll encode it.
 */
import {
  parseDataforseoLighthousePayload,
  REQUEST_CATEGORIES,
} from "./payload.js";

const API_URL = "https://api.dataforseo.com/v3/on_page/lighthouse/live/json";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * One payload read+parse at a time. The raw Lighthouse report is 1–10 MB and
 * is held several times over while parsing; concurrent checks finishing
 * together would multiply that. The HTTP requests themselves stay concurrent —
 * parsing takes well under a second against a 30–60s fetch.
 */
let parseChain = Promise.resolve();
function withParseLock(fn) {
  const run = parseChain.then(fn, fn);
  parseChain = run.catch(() => {});
  return run;
}

function readApiKey() {
  const key = process.env.DATAFORSEO_API_KEY?.trim();
  if (key) return key;

  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  if (login && password) {
    return Buffer.from(`${login}:${password}`).toString("base64");
  }
  return null;
}

/** Whether this deployment can run Lighthouse checks at all. */
export function isLighthouseAvailable() {
  return readApiKey() !== null;
}

/**
 * Run one Lighthouse check. Resolves to the stored payload, or throws with a
 * message that goes straight onto the result row.
 */
export async function fetchLighthousePayload({ url, strategy }) {
  const apiKey = readApiKey();
  if (!apiKey) throw new Error("DATAFORSEO_API_KEY is not set");

  // Billed, non-idempotent POST: a 5xx does not prove the provider skipped the
  // charge, so this is never retried. The timeout is cleared once headers
  // arrive, so a body read queued behind the parse lock can't be aborted after
  // the call was already billed.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          url,
          for_mobile: strategy === "mobile",
          categories: REQUEST_CATEGORIES,
        },
      ]),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 402) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401
        ? "DataForSEO rejected the API key"
        : "DataForSEO reports insufficient balance",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DataForSEO responded ${response.status}`);
  }

  return withParseLock(async () => {
    const body = await response.json();
    return parseDataforseoLighthousePayload(body, { url, strategy });
  });
}
