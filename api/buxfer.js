import { createMcpHandler } from "../lib/mcp.js";
import { buxferTools } from "../lib/buxfer-tools.js";
import { credsFromRequest } from "../lib/buxfer.js";

const handler = createMcpHandler({
  name: "buxfer",
  version: "1.1.0",
  instructions:
    "Read-only access to the connected Buxfer account. Use buxfer_accounts to find account names/ids, " +
    "then buxfer_transactions with a date range to look up specific payments. Nothing here can change Buxfer data.",
  tools: buxferTools,
  // The access key is always required (checked in createMcpHandler); the Buxfer login comes from connector headers.
  context: (request) => ({ creds: credsFromRequest(request) }),
});

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
