import { createMcpHandler } from "../lib/mcp.js";
import { buxferTools } from "../lib/buxfer-tools.js";
import { addTransactionTool, writeEnabled } from "../lib/buxfer-write.js";
import { credsFromRequest } from "../lib/buxfer.js";

const LOOKUP =
  "Use buxfer_accounts to find account names/ids, then buxfer_transactions with a date range to look up specific payments.";

const handler = createMcpHandler({
  name: "buxfer",
  version: "1.2.0",
  // Both depend on BUXFER_WRITE_ENABLED; without it the server stays read-only and never lists the write tool.
  instructions: () =>
    writeEnabled()
      ? `Access to the connected Buxfer account. ${LOOKUP} ` +
        "buxfer_add_transaction can add new transactions (never edit or delete). Everything else is read-only."
      : `Read-only access to the connected Buxfer account. ${LOOKUP} Nothing here can change Buxfer data.`,
  tools: () => (writeEnabled() ? [...buxferTools, addTransactionTool] : buxferTools),
  // The access key is always required (checked in createMcpHandler); the Buxfer login comes from connector headers.
  context: (request) => ({ creds: credsFromRequest(request) }),
});

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
