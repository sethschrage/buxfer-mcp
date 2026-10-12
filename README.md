# buxfer-mcp

A small, read-only [MCP](https://modelcontextprotocol.io) server that lets Claude look at a [Buxfer](https://www.buxfer.com) account: accounts, transactions, loans (IOUs), tags, budgets, reminders, contacts and groups. It runs as a single Vercel function and has no runtime dependencies.

Nothing here can add, change or delete Buxfer data. Every tool is annotated `readOnlyHint: true`.

## How it works

- `api/buxfer.js`: the Vercel function (Web `Request` → `Response`), exported for `GET`, `POST` and `DELETE`.
- `lib/mcp.js`: a minimal MCP server over Streamable HTTP (stateless JSON responses): `initialize`, `ping`, `tools/list`, `tools/call`, notifications, batches.
- `lib/buxfer.js`: the Buxfer API client. Buxfer only offers email + password login, which returns a session token. Tokens are cached per warm instance (keyed by a hash of the credentials) and refreshed once on expiry.
- `lib/buxfer-tools.js`: the tool definitions. `buxfer_transactions` pages through Buxfer's 100-per-page results (up to 10 pages) and can filter locally by description text and amount range.

## Authentication

Two layers:

1. **Access key** (required on every request). Set `MCP_ACCESS_KEY` (32+ characters) in Vercel. Clients send it as `?key=…` in the URL or as `Authorization: Bearer …`. Requests without it get `401`. The server refuses to run with a missing or short key.
2. **Buxfer login**, from either:
   - connector request headers `X-Buxfer-Email` / `X-Buxfer-Password` (each user brings their own login), or
   - Vercel env vars `BUXFER_EMAIL` / `BUXFER_PASSWORD` (single-user fallback).

Credentials are never logged or returned; error messages only repeat Buxfer's own reason (for example "Email does not match an existing account.").

## Deploy

1. Import this repo into Vercel (no framework, no build step).
2. Add environment variables (type **Sensitive**, Production):
   - `MCP_ACCESS_KEY`: e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - `BUXFER_EMAIL`, `BUXFER_PASSWORD` (optional if clients send headers)
3. Redeploy after changing variables.
4. In Claude: Settings → Connectors → Add custom connector, URL `https://<project>.vercel.app/api/buxfer?key=<MCP_ACCESS_KEY>`, authentication **No sign-in**.

## Tests

```
node test/run.mjs
```

The tests run against a fake Buxfer (no network) and cover auth, protocol handling, paging and filters, token expiry and re-login, header logins, and that passwords never appear in errors.

## Tools

| Tool | What it returns |
|---|---|
| `buxfer_accounts` | Accounts with ids, banks, balances, last sync |
| `buxfer_transactions` | Transactions filtered by account, tag, date range, status, text, amount |
| `buxfer_loans` | IOU balances with contacts and groups |
| `buxfer_tags` | Tags with parent tags |
| `buxfer_budgets` | Budgets with limits and remaining amounts |
| `buxfer_reminders` | Recurring bill reminders |
| `buxfer_contacts` | Contacts and balances |
| `buxfer_groups` | Groups and member balances |

## License

MIT
