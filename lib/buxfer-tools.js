import { buxfer } from "./buxfer.js";

export const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD" };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const noArgs = { type: "object", properties: {}, additionalProperties: false };

export function pickTxn(t) {
  return {
    id: t.id,
    date: t.date,
    description: t.description,
    amount: t.amount,
    expenseAmount: t.expenseAmount,
    type: t.type,
    status: t.status,
    accountId: t.accountId,
    accountName: t.accountName,
    tags: t.tagNames ?? t.tags,
    extraInfo: t.extraInfo,
  };
}

async function transactions(args, ctx) {
  const {
    accountId,
    accountName,
    tagName,
    startDate,
    endDate,
    status,
    search,
    minAmount,
    maxAmount,
    maxPages = 3,
  } = args;
  if ((startDate && !endDate) || (!startDate && endDate)) {
    throw new Error("startDate and endDate must be given together.");
  }
  const pages = Math.min(Math.max(1, Number(maxPages) || 1), 10);
  const filters = { accountId, accountName, tagName, startDate, endDate, status };
  let all = [];
  let total = 0;
  let fetchedPages = 0;
  for (let page = 1; page <= pages; page++) {
    const r = await buxfer.transactions(ctx.creds, { ...filters, page });
    fetchedPages = page;
    total = Number(r.numTransactions ?? 0);
    const batch = r.transactions || [];
    all = all.concat(batch);
    if (batch.length < 100 || all.length >= total) break;
  }
  let txns = all.map(pickTxn);
  if (search) {
    const q = String(search).toLowerCase();
    txns = txns.filter((t) => String(t.description || "").toLowerCase().includes(q));
  }
  if (minAmount !== undefined) txns = txns.filter((t) => Math.abs(Number(t.amount)) >= Number(minAmount));
  if (maxAmount !== undefined) txns = txns.filter((t) => Math.abs(Number(t.amount)) <= Number(maxAmount));
  return {
    totalMatchingInBuxfer: total,
    pagesFetched: fetchedPages,
    moreAvailable: all.length < total,
    returned: txns.length,
    transactions: txns,
  };
}

export const buxferTools = [
  {
    name: "buxfer_accounts",
    title: "Buxfer accounts",
    description: "List all Buxfer accounts with their ids, banks, balances and last sync time.",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => {
      const r = await buxfer.accounts(ctx.creds);
      return { accounts: r.accounts || [] };
    },
  },
  {
    name: "buxfer_transactions",
    title: "Buxfer transactions",
    description:
      "List Buxfer transactions, newest first. Filter by account (id or name), tag, date range (both startDate and endDate), and status. " +
      "Buxfer returns 100 per page; this fetches up to maxPages pages (default 3, max 10). " +
      "search, minAmount and maxAmount filter the fetched results locally (amounts compared as absolute values).",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        accountName: { type: "string", description: "Exact Buxfer account name, e.g. 'Checking'" },
        tagName: { type: "string" },
        startDate: DATE,
        endDate: DATE,
        status: { type: "string", enum: ["pending", "reconciled", "cleared"] },
        search: { type: "string", description: "Case-insensitive substring match on description" },
        minAmount: { type: "number" },
        maxAmount: { type: "number" },
        maxPages: { type: "integer", minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: transactions,
  },
  {
    name: "buxfer_loans",
    title: "Buxfer loans (IOUs)",
    description: "List balances owed to and from Buxfer contacts and groups.",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => ({ loans: (await buxfer.loans(ctx.creds)).loans || [] }),
  },
  {
    name: "buxfer_tags",
    title: "Buxfer tags",
    description: "List Buxfer transaction tags with their parent tags.",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => ({ tags: (await buxfer.tags(ctx.creds)).tags || [] }),
  },
  {
    name: "buxfer_budgets",
    title: "Buxfer budgets",
    description: "List Buxfer budgets with limit, remaining amount and current period.",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => ({ budgets: (await buxfer.budgets(ctx.creds)).budgets || [] }),
  },
  {
    name: "buxfer_reminders",
    title: "Buxfer reminders",
    description: "List Buxfer bill reminders (recurring expected payments).",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => ({ reminders: (await buxfer.reminders(ctx.creds)).reminders || [] }),
  },
  {
    name: "buxfer_contacts",
    title: "Buxfer contacts",
    description: "List Buxfer contacts and their balances.",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => ({ contacts: (await buxfer.contacts(ctx.creds)).contacts || [] }),
  },
  {
    name: "buxfer_groups",
    title: "Buxfer groups",
    description: "List Buxfer groups and member balances.",
    inputSchema: noArgs,
    annotations: readOnly,
    handler: async (_args, ctx) => ({ groups: (await buxfer.groups(ctx.creds)).groups || [] }),
  },
];
