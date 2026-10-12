// Optional, add-only write access. Off unless BUXFER_WRITE_ENABLED is "true".
import { buxfer } from "./buxfer.js";
import { DATE, pickTxn } from "./buxfer-tools.js";

const DEFAULT_MAX_AMOUNT = 50000;
const MAX_DESCRIPTION = 200;
const MAX_PAGES = 10;

// How each kind maps onto Buxfer's transaction_add fields.
const KINDS = {
  transfer_in: { type: "transfer", accountField: "toAccountId" },
  transfer_out: { type: "transfer", accountField: "fromAccountId" },
  expense: { type: "expense", accountField: "accountId" },
  income: { type: "income", accountField: "accountId" },
};
const STATUSES = ["cleared", "pending"];

const norm = (s) => String(s ?? "").trim().toLowerCase();
const cents = (n) => Math.round(Math.abs(Number(n)) * 100);

/** Whether the write tool is on: BUXFER_WRITE_ENABLED=true. Any other value, or none, leaves the server read-only. */
export function writeEnabled() {
  return (process.env.BUXFER_WRITE_ENABLED || "").trim().toLowerCase() === "true";
}

function maxAmount() {
  const n = Number(process.env.BUXFER_WRITE_MAX_AMOUNT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AMOUNT;
}

function isRealDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Checks every input before anything touches Buxfer.
function validate(args) {
  const { account, date, amount, description, kind, tags = [], status = "cleared", dryRun = false } = args;
  if (typeof account !== "string" || !account.trim()) throw new Error("account is required.");
  if (!isRealDate(date)) throw new Error("date must be a real date in YYYY-MM-DD form.");
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive number.");
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new Error("amount can have at most 2 decimal places.");
  }
  const max = maxAmount();
  if (amount > max) throw new Error(`amount is over the limit of ${max.toFixed(2)}.`);
  const text = typeof description === "string" ? description.trim() : "";
  if (!text || text.length > MAX_DESCRIPTION) {
    throw new Error(`description must be 1 to ${MAX_DESCRIPTION} characters.`);
  }
  const mapping = KINDS[kind];
  if (!mapping) throw new Error(`kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.includes(","))) {
    throw new Error("tags must be a list of tag names without commas.");
  }
  if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}.`);
  return {
    account: account.trim(),
    date,
    amount,
    description: text,
    mapping,
    tags: tags.map((t) => t.trim()).filter(Boolean),
    status,
    dryRun: dryRun === true,
  };
}

// An existing transaction on the same account and date with the same amount (to the cent) and description.
async function findDuplicate(creds, accountId, { date, amount, description }) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await buxfer.transactions(creds, { accountId, startDate: date, endDate: date, page });
    const batch = r.transactions || [];
    const hit = batch.find(
      (t) =>
        String(t.date || "").slice(0, 10) === date &&
        cents(t.amount) === cents(amount) &&
        norm(t.description) === norm(description),
    );
    if (hit) return hit;
    if (batch.length < 100) return null;
  }
  return null;
}

async function addTransaction(args, ctx) {
  const input = validate(args);

  const matches = ((await buxfer.accounts(ctx.creds)).accounts || []).filter(
    (a) => norm(a.name) === norm(input.account),
  );
  if (matches.length === 0) throw new Error(`No Buxfer account is named "${input.account}".`);
  if (matches.length > 1) throw new Error(`More than one Buxfer account is named "${input.account}".`);
  const accountId = matches[0].id;

  // Retries are safe: the same entry on the same day is reported, not added twice.
  const existing = await findDuplicate(ctx.creds, accountId, input);
  if (existing) return { status: "already_exists", transaction: pickTxn(existing) };

  const fields = {
    description: input.description,
    amount: input.amount.toFixed(2),
    date: input.date,
    status: input.status,
    type: input.mapping.type,
    [input.mapping.accountField]: accountId,
  };
  if (input.tags.length) fields.tags = input.tags.join(",");

  if (input.dryRun) return { status: "dry_run", wouldSend: fields };

  const created = await buxfer.addTransaction(ctx.creds, fields);
  return { status: "added", transaction: pickTxn(created.transaction ?? created) };
}

export const addTransactionTool = {
  name: "buxfer_add_transaction",
  title: "Add a Buxfer transaction",
  description:
    "Add one new transaction to a Buxfer account. Add-only: nothing can be edited or deleted. " +
    "kind: transfer_in (money into the account), transfer_out (money out of it), expense or income. " +
    "If the account already has a transaction on that date with the same amount and description, nothing is added and " +
    "status is already_exists, so retrying is safe. Use dryRun to see what would be sent without adding anything.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", description: "Exact Buxfer account name (from buxfer_accounts)" },
      date: DATE,
      amount: { type: "number", exclusiveMinimum: 0, description: "Positive amount, at most 2 decimal places" },
      description: { type: "string", minLength: 1, maxLength: MAX_DESCRIPTION },
      kind: { type: "string", enum: Object.keys(KINDS) },
      tags: { type: "array", items: { type: "string" }, description: "Buxfer tag names" },
      status: { type: "string", enum: STATUSES, default: "cleared" },
      dryRun: { type: "boolean", description: "Return what would be sent and add nothing" },
    },
    required: ["account", "date", "amount", "description", "kind"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: addTransaction,
};
