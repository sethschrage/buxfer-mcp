import assert from "node:assert/strict";

process.env.MCP_ACCESS_KEY = "k".repeat(40);
process.env.BUXFER_EMAIL = "me@example.com";
process.env.BUXFER_PASSWORD = "secret-pass";

let logins = 0;
let expireNext = false;
const txns = Array.from({ length: 130 }, (_, i) => ({
  id: String(i),
  date: "2026-10-01",
  description: i === 5 ? "ONLINE TRANSFER LOAN PAYMENT" : `Thing ${i}`,
  amount: i === 5 ? 2500 : 10 + i,
  type: "expense",
  accountName: "Checking",
}));

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const cmd = u.pathname.split("/").pop();
  const reply = (response, status = 200) => new Response(JSON.stringify({ response }), { status });
  if (cmd === "login") {
    const body = new URLSearchParams(opts.body);
    assert.equal(opts.method, "POST");
    assert.equal(body.get("password"), "secret-pass");
    logins++;
    return reply({ status: "OK", token: `tok${logins}` });
  }
  if (expireNext) {
    expireNext = false;
    return reply({ status: "ERROR: Invalid token" });
  }
  assert.ok(u.searchParams.get("token")?.startsWith("tok"));
  if (cmd === "accounts") return reply({ status: "OK", accounts: [{ id: "a1", name: "Checking", balance: 1 }] });
  if (cmd === "transactions") {
    const page = Number(u.searchParams.get("page") || 1);
    return reply({ status: "OK", numTransactions: txns.length, transactions: txns.slice((page - 1) * 100, page * 100) });
  }
  return reply({ status: "OK", [cmd]: [] });
};

const { POST, GET } = await import("../api/buxfer.js");
const base = "https://x.vercel.app/api/buxfer";
const rpc = (body, key = process.env.MCP_ACCESS_KEY) =>
  POST(new Request(`${base}?key=${key}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

// auth
assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong")).status, 401);
assert.equal((await GET(new Request(`${base}?key=${process.env.MCP_ACCESS_KEY}`))).status, 405);
const bearer = await POST(new Request(base, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), headers: { authorization: `Bearer ${process.env.MCP_ACCESS_KEY}` } }));
assert.equal(bearer.status, 200);

// weak key refused
const saved = process.env.MCP_ACCESS_KEY;
process.env.MCP_ACCESS_KEY = "short";
assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "short")).status, 401);
process.env.MCP_ACCESS_KEY = saved;

// initialize + notification
const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
assert.equal(init.result.protocolVersion, "2025-03-26");
assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

// tools/list
const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
const names = list.result.tools.map((t) => t.name);
assert.ok(names.includes("buxfer_transactions") && names.includes("buxfer_accounts"));
assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint === true));

// accounts
const acc = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "buxfer_accounts", arguments: {} } })).json();
assert.equal(acc.result.structuredContent.accounts[0].name, "Checking");

// transactions paging + filters
const tx = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "buxfer_transactions", arguments: { accountName: "Checking", startDate: "2026-09-27", endDate: "2026-10-04", minAmount: 2499, maxAmount: 2501 } } })).json();
assert.equal(tx.result.structuredContent.pagesFetched, 2);
assert.equal(tx.result.structuredContent.returned, 1);
assert.equal(tx.result.structuredContent.transactions[0].amount, 2500);

// date range validation surfaces as tool error
const bad = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "buxfer_transactions", arguments: { startDate: "2026-10-01" } } })).json();
assert.equal(bad.result.isError, true);

// expired token -> relogin once
const before = logins;
expireNext = true;
const again = await (await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "buxfer_accounts", arguments: {} } })).json();
assert.ok(!again.result.isError);
assert.equal(logins, before + 1);

// password never leaks into errors
process.env.BUXFER_PASSWORD = "";
const { _resetToken } = await import("../lib/buxfer.js");
_resetToken();
const noCreds = await (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "buxfer_tags", arguments: {} } })).json();
assert.equal(noCreds.result.isError, true);
assert.ok(!JSON.stringify(noCreds).includes("secret-pass"));

// unknown method / tool
assert.equal((await (await rpc({ jsonrpc: "2.0", id: 8, method: "nope" })).json()).error.code, -32601);
assert.equal((await (await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } })).json()).error.code, -32602);

// header credentials: used when present, but never a substitute for the access key
_resetToken();
const hdrLogin = { "x-buxfer-email": "other@example.com", "x-buxfer-password": "secret-pass" };
const call = (headers) =>
  POST(new Request(base, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "buxfer_accounts", arguments: {} } }), headers }));
assert.equal((await call(hdrLogin)).status, 401, "Buxfer headers alone must not grant access");
const viaHeaders = await (await call({ ...hdrLogin, authorization: `Bearer ${process.env.MCP_ACCESS_KEY}` })).json();
assert.ok(!viaHeaders.result.isError, "header login works with access key");
// env login still empty here, so success proves the header login was used
assert.equal(process.env.BUXFER_PASSWORD, "");

console.log("all tests passed");
