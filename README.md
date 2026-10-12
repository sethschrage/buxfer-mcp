# buxfer-mcp

A small [MCP](https://modelcontextprotocol.io) server that lets Claude look at a [Buxfer](https://www.buxfer.com) account: accounts, transactions, loans (IOUs), tags, budgets, reminders, contacts and groups. It runs as a single Vercel function and has no runtime dependencies.

By default nothing here can add, change or delete Buxfer data, and every tool is annotated `readOnlyHint: true`. One add-only write tool can be switched on; see [Optional write access](#optional-write-access).

## How it works

- `api/buxfer.js`: the Vercel function (Web `Request` → `Response`), exported for `GET`, `POST` and `DELETE`.
- `lib/mcp.js`: a minimal MCP server over Streamable HTTP (stateless JSON responses): `initialize`, `ping`, `tools/list`, `tools/call`, notifications, batches.
- `lib/buxfer.js`: the Buxfer API client. Buxfer only offers email + password login, which returns a session token. Tokens are cached per warm instance (keyed by a hash of the credentials) and refreshed once on expiry.
- `lib/buxfer-tools.js`: the read-only tool definitions. `buxfer_transactions` pages through Buxfer's 100-per-page results (up to 10 pages) and can filter locally by description text and amount range.
- `lib/buxfer-write.js`: the optional `buxfer_add_transaction` tool.

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
   - `BUXFER_WRITE_ENABLED`, `BUXFER_WRITE_MAX_AMOUNT` (optional; see below)
3. Redeploy after changing variables.
4. In Claude: Settings → Connectors → Add custom connector, URL `https://<project>.vercel.app/api/buxfer?key=<MCP_ACCESS_KEY>`, authentication **No sign-in**.

## Optional write access

Off by default. With it off, `buxfer_add_transaction` is not listed at all and the server describes itself as read-only.

| Variable | Effect |
|---|---|
| `BUXFER_WRITE_ENABLED` | `true` lists `buxfer_add_transaction`, which can add a transaction to any account. Any other value, or none, keeps the server read-only. |
| `BUXFER_WRITE_MAX_AMOUNT` | Largest single amount the tool accepts. Default `50000`. |

Neither needs to be Sensitive. Redeploy after changing them.

What the tool does and doesn't do:

- **Add-only.** It creates one transaction per call. There are no edit or delete tools.
- **Kinds.** `transfer_in` and `transfer_out` create a transfer into or out of the named account; `expense` and `income` create that type on the account.
- **Checks first.** The account must exist (exact name, any case); the date must be a real `YYYY-MM-DD` date; the amount must be positive, have at most 2 decimals and be within the limit; the description must be 1–200 characters. Anything else is refused before Buxfer is contacted.
- **Duplicate guard.** Before adding, it looks at that account's transactions on that date. If one has the same amount (to the cent) and the same description (ignoring case and surrounding spaces), it adds nothing and returns `status: "already_exists"` with that transaction, so retrying a call is safe.
- **Dry run.** `dryRun: true` returns the fields it would send and adds nothing.
- The Buxfer session token goes in the POST body, never in the URL.

## Tests

```
npm test
```

The tests run against a fake Buxfer (no network). `test/run.mjs` covers auth, protocol handling, paging and filters, token expiry and re-login, header logins, and that passwords never appear in errors. `test/write.mjs` covers the write switch, each transaction kind, the duplicate guard, dry runs, every refusal, and that the token stays out of URLs and results.

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
| `buxfer_add_transaction` | Only when `BUXFER_WRITE_ENABLED=true`: adds one transaction, or reports the existing one |

## License

MIT
