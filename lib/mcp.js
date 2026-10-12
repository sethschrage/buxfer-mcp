// Minimal, dependency-free MCP server over Streamable HTTP (stateless JSON responses).
import { timingSafeEqual } from "node:crypto";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function checkAccess(request) {
  const expected = process.env.MCP_ACCESS_KEY || "";
  if (expected.length < 32) return false; // refuse to run with a missing or weak key
  const url = new URL(request.url);
  let given = url.searchParams.get("key") || "";
  const auth = request.headers.get("authorization") || "";
  if (!given && auth.toLowerCase().startsWith("bearer ")) given = auth.slice(7).trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * tools: Array<{ name, description, inputSchema, handler(args) => Promise<any> }>
 */
export function createMcpHandler({ name, version, instructions, tools, context = () => ({}) }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handleMessage(msg, ctx) {
    const { id, method, params } = msg || {};
    const isNotification = id === undefined || id === null;
    if (typeof method !== "string") return isNotification ? null : rpcError(id, -32600, "Invalid request");
    if (isNotification) return null; // notifications/initialized etc.

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            instructions,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
              name,
              title,
              description,
              inputSchema,
              annotations,
            })),
          },
        };
      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const data = await tool.handler(params?.arguments || {}, ctx);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: wrap(data) },
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: { isError: true, content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }] },
          };
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return async function handle(request) {
    if (!checkAccess(request)) return json({ error: "unauthorized" }, 401);
    const ctx = context(request);
    if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const out = await handleMessage(body, ctx);
    return out ? json(out) : new Response(null, { status: 202 });
  };
}

// structuredContent must be an object
function wrap(data) {
  return data && typeof data === "object" && !Array.isArray(data) ? data : { result: data };
}
