import assert from "node:assert/strict";

process.env.MCP_ACCESS_KEY = "k".repeat(40);
process.env.BUXFER_EMAIL = "me@example.com";
process.env.BUXFER_PASSWORD = "secret-pass";
delete process.env.BUXFER_WRITE_ENABLED;
delete process.env.BUXFER_WRITE_MAX_AMOUNT;

const accounts = [
  { id: 11, name: "Checking" },
  { id: 22, name: "Savings" },
  { id: 33, name: "Card" },
];
const existing = [{ id: "t1", date: "2026-03-02", description: "Monthly transfer", amount: 250, type: "transfer", accountId: 22 }];

let logins = 0;
let expireNextPost = false;
const posts = []; // every transaction_add request: { url, body }
let nextId = 100;

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const cmd = u.pathname.split("/").pop();
  const reply = (response, status = 200) => new Response(JSON.stringify({ response }), { status });
  if (cmd === "login") {
    logins++;
    return reply({ status: "OK", token: `tok${logins}` });
  }
  if (cmd === "transaction_add") {
    assert.equal(opts.method, "POST");
    const body = new URLSearchParams(opts.body);
    posts.push({ url: String(url), body });
    if (expireNextPost) {
      expireNextPost = false;
      return reply({ status: "ERROR: Invalid token" });
    }
    assert.ok(body.get("token")?.startsWith("tok"));
    // Like Buxfer: the created transaction, with its own status and no "OK".
    return reply({
      id: nextId++,
      description: body.get("description"),
      date: body.get("date"),
      type: body.get("type"),
      amount: Number(body.get("amount")),
      accountName: "Savings",
      tags: body.get("tags") || "",
      status: body.get("status"),
    });
  }
  assert.equal(opts.method ?? "GET", "GET");
  assert.ok(u.searchParams.get("token")?.startsWith("tok"));
  if (cmd === "accounts") return reply({ status: "OK", accounts });
  if (cmd === "transactions") {
    const id = Number(u.searchParams.get("accountId"));
    const start = u.searchParams.get("startDate");
    const end = u.searchParams.get("endDate");
    const list = existing.filter((t) => t.accountId === id && t.date >= start && t.date <= end);
    return reply({ status: "OK", numTransactions: list.length, transactions: list });
  }
  return reply({ status: "OK", [cmd]: [] });
};

const { POST } = await import("../api/buxfer.js");
const base = `https://x.vercel.app/api/buxfer?key=${process.env.MCP_ACCESS_KEY}`;
let rid = 0;
const rpc = async (method, params) =>
  (await POST(new Request(base, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) }))).json();
const add = (args) => rpc("tools/call", { name: "buxfer_add_transaction", arguments: args });
const listNames = async () => (await rpc("tools/list")).result.tools.map((t) => t.name);

// off by default: tool hidden, instructions say read-only, calls rejected
assert.ok(!(await listNames()).includes("buxfer_add_transaction"));
assert.match((await rpc("initialize", {})).result.instructions, /Nothing here can change Buxfer data\./);
assert.equal((await add({ account: "Savings" })).error.code, -32602);
assert.equal(posts.length, 0);

// only the exact value "true" (any case) turns it on
for (const value of ["false", "yes", "1", ""]) {
  process.env.BUXFER_WRITE_ENABLED = value;
  assert.ok(!(await listNames()).includes("buxfer_add_transaction"), `"${value}" must not enable writing`);
}

// on: listed with write annotations, and mentioned in the instructions
process.env.BUXFER_WRITE_ENABLED = " TRUE ";
const tools = (await rpc("tools/list")).result.tools;
const tool = tools.find((t) => t.name === "buxfer_add_transaction");
assert.ok(tool, "write tool listed when writing is enabled");
assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
assert.ok(tools.filter((t) => t !== tool).every((t) => t.annotations.readOnlyHint === true));
const instructions = (await rpc("initialize", {})).result.instructions;
assert.match(instructions, /buxfer_add_transaction/);
assert.doesNotMatch(instructions, /Checking|Savings|Card/, "no account names in the instructions");
assert.doesNotMatch(instructions, /Nothing here can change/);

const base1 = { account: "Savings", date: "2026-03-05", amount: 123.45, description: "Test entry" };

// dryRun sends nothing and shows the fields, without the token
const dry = (await add({ ...base1, kind: "transfer_in", dryRun: true })).result;
assert.ok(!dry.isError);
assert.equal(dry.structuredContent.status, "dry_run");
assert.deepEqual(dry.structuredContent.wouldSend, {
  description: "Test entry",
  amount: "123.45",
  date: "2026-03-05",
  status: "cleared",
  type: "transfer",
  toAccountId: 22,
});
assert.equal(posts.length, 0);

// each kind maps to the right type and account field; token in the body, not the URL
const expected = {
  transfer_in: ["transfer", "toAccountId"],
  transfer_out: ["transfer", "fromAccountId"],
  expense: ["expense", "accountId"],
  income: ["income", "accountId"],
};
for (const [kind, [type, field]] of Object.entries(expected)) {
  const out = (await add({ ...base1, description: `Entry ${kind}`, kind, tags: ["One", "Two"] })).result;
  assert.ok(!out.isError, `${kind}: ${out.content?.[0]?.text}`);
  assert.equal(out.structuredContent.status, "added");
  assert.equal(out.structuredContent.transaction.description, `Entry ${kind}`);
  assert.equal(out.structuredContent.transaction.status, "cleared");
  const { url, body } = posts.at(-1);
  assert.equal(new URL(url).search, "", "nothing in the URL query");
  assert.ok(!url.includes("tok"), "token not in the URL");
  assert.ok(body.get("token").startsWith("tok"), "token in the POST body");
  assert.equal(body.get("type"), type);
  assert.equal(body.get(field), "22");
  for (const other of ["toAccountId", "fromAccountId", "accountId"].filter((f) => f !== field)) {
    assert.equal(body.get(other), null, `${kind} must not send ${other}`);
  }
  assert.equal(body.get("amount"), "123.45");
  assert.equal(body.get("tags"), "One,Two");
  assert.equal(body.get("status"), "cleared");
  assert.ok(!JSON.stringify(out).includes("tok"), "token never returned");
}
assert.equal(posts.length, 4);

// account names match case-insensitively; whole amounts go out with 2 decimals; status passes through
const lower = (await add({ ...base1, account: "card", amount: 7, description: "Small", kind: "expense", status: "pending" })).result;
assert.ok(!lower.isError, lower.content?.[0]?.text);
assert.equal(posts.at(-1).body.get("accountId"), "33");
assert.equal(posts.at(-1).body.get("amount"), "7.00");
assert.equal(posts.at(-1).body.get("status"), "pending");

// duplicate guard: same account, date, amount and description (ignoring case and spaces) adds nothing
const before = posts.length;
const dup = (await add({ account: "Savings", date: "2026-03-02", amount: 250, description: "  monthly TRANSFER ", kind: "transfer_in" })).result;
assert.ok(!dup.isError);
assert.equal(dup.structuredContent.status, "already_exists");
assert.equal(dup.structuredContent.transaction.id, "t1");
assert.equal(posts.length, before);
// ...and a dry run reports the duplicate too
assert.equal((await add({ account: "Savings", date: "2026-03-02", amount: 250, description: "Monthly transfer", kind: "income", dryRun: true })).result.structuredContent.status, "already_exists");
assert.equal(posts.length, before);
// a different amount on the same day is not a duplicate
assert.equal((await add({ account: "Savings", date: "2026-03-02", amount: 250.01, description: "Monthly transfer", kind: "transfer_in", dryRun: true })).result.structuredContent.status, "dry_run");

// any account can be written to
assert.equal((await add({ ...base1, account: "Checking", kind: "expense", dryRun: true })).result.structuredContent.wouldSend.accountId, 11);

// refusals post nothing
const refusals = [
  [{ ...base1, account: "Ghost", kind: "expense" }, /No Buxfer account/],
  [{ ...base1, amount: 0, kind: "expense" }, /positive/],
  [{ ...base1, amount: -5, kind: "expense" }, /positive/],
  [{ ...base1, amount: 1.234, kind: "expense" }, /2 decimal/],
  [{ ...base1, amount: 50000.01, kind: "expense" }, /over the limit of 50000\.00/],
  [{ ...base1, amount: "12", kind: "expense" }, /positive/],
  [{ ...base1, date: "2026-02-30", kind: "expense" }, /real date/],
  [{ ...base1, date: "03/05/2026", kind: "expense" }, /real date/],
  [{ ...base1, description: "   ", kind: "expense" }, /description/],
  [{ ...base1, description: "x".repeat(201), kind: "expense" }, /description/],
  [{ ...base1, kind: "refund" }, /kind must be one of/],
  [{ ...base1, kind: "expense", tags: ["a,b"] }, /tags/],
  [{ ...base1, kind: "expense", status: "reconciled" }, /status/],
];
const beforeRefusals = posts.length;
for (const [args, why] of refusals) {
  const out = (await add(args)).result;
  assert.equal(out.isError, true, `should refuse ${JSON.stringify(args).slice(0, 80)}`);
  assert.match(out.content[0].text, why);
}
// the cap comes from BUXFER_WRITE_MAX_AMOUNT when set
process.env.BUXFER_WRITE_MAX_AMOUNT = "1000";
const capped = (await add({ ...base1, amount: 1000.01, kind: "expense" })).result;
assert.equal(capped.isError, true);
assert.match(capped.content[0].text, /over the limit of 1000\.00/);
assert.ok(!(await add({ ...base1, amount: 1000, description: "At cap", kind: "expense", dryRun: true })).result.isError);
delete process.env.BUXFER_WRITE_MAX_AMOUNT;
assert.equal(posts.length, beforeRefusals);

// an expired token on the write path: log in again once and retry
const loginsBefore = logins;
expireNextPost = true;
const retried = (await add({ ...base1, description: "After expiry", kind: "income" })).result;
assert.ok(!retried.isError, retried.content?.[0]?.text);
assert.equal(retried.structuredContent.status, "added");
assert.equal(logins, loginsBefore + 1);
assert.equal(posts.length, beforeRefusals + 2, "one failed attempt, one retry");

// password never appears in any output
assert.ok(!JSON.stringify(retried).includes("secret-pass"));

// turning the setting off hides the tool again
process.env.BUXFER_WRITE_ENABLED = "false";
assert.ok(!(await listNames()).includes("buxfer_add_transaction"));

console.log("all write tests passed");
