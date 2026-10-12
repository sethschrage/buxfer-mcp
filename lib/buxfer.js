// Read-only Buxfer API client. Credentials come per request (connector headers),
// falling back to environment variables. They are never logged or returned.
import { createHash } from "node:crypto";

const BASE = "https://www.buxfer.com/api";

// Buxfer session tokens, keyed by a hash of the credentials, reused while the instance stays warm.
const tokens = new Map();
const keyFor = ({ email, password }) => createHash("sha256").update(`${email}\u0000${password}`).digest("hex");

function resolveCreds(creds) {
  const email = (creds?.email || process.env.BUXFER_EMAIL || "").trim();
  const password = creds?.password || process.env.BUXFER_PASSWORD;
  if (!email || !password) {
    throw new Error("No Buxfer login provided. Add X-Buxfer-Email and X-Buxfer-Password headers to the connector.");
  }
  return { email, password };
}

async function login(creds) {
  const { email, password } = creds;
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  const r = data?.response;
  if (!res.ok || !r || r.status !== "OK" || !r.token) {
    // Never echo credentials; only what Buxfer said.
    throw new Error(`Buxfer login failed (HTTP ${res.status}): ${buxferReason(data, r)}`);
  }
  tokens.set(keyFor(creds), r.token);
  return r.token;
}

async function call(rawCreds, command, params = {}, retried = false) {
  const creds = resolveCreds(rawCreds);
  const token = tokens.get(keyFor(creds)) || (await login(creds));
  const qs = new URLSearchParams({ token });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const res = await fetch(`${BASE}/${command}?${qs}`);
  const data = await res.json().catch(() => null);
  const r = data?.response;
  const status = r?.status || "";
  const failed = !res.ok || !r || (status && status !== "OK");
  if (failed) {
    if (!retried && (res.status === 401 || res.status === 403 || /token|login|session/i.test(status))) {
      tokens.delete(keyFor(creds));
      return call(creds, command, params, true);
    }
    throw new Error(`Buxfer ${command} failed (HTTP ${res.status}): ${buxferReason(data, r)}`);
  }
  return r;
}

export const buxfer = {
  accounts: (c) => call(c, "accounts"),
  loans: (c) => call(c, "loans"),
  tags: (c) => call(c, "tags"),
  budgets: (c) => call(c, "budgets"),
  reminders: (c) => call(c, "reminders"),
  groups: (c) => call(c, "groups"),
  contacts: (c) => call(c, "contacts"),
  transactions: (c, filters) => call(c, "transactions", filters),
};

function buxferReason(data, r) {
  const msg = data?.error?.message || data?.error?.type || r?.status || (typeof data?.error === "string" ? data.error : "");
  return String(msg || "no reason given").slice(0, 200);
}

export function credsFromRequest(request) {
  const email = request.headers.get("x-buxfer-email")?.trim();
  const password = request.headers.get("x-buxfer-password");
  return email && password ? { email, password } : null;
}

// Exposed for tests only.
export function _resetToken() {
  tokens.clear();
}
