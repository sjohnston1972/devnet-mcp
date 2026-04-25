interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  MCP_URL: string;
  AI_MODEL: string;
  MERAKI_SANDBOX_API_KEY?: string;
  MERAKI_SANDBOX_NAME?: string;
  MERAKI_SANDBOX_BASE?: string;
  MERAKI_SANDBOX_ORG_ID?: string;
  MERAKI_SANDBOX_NETWORK_ID?: string;
  MERAKI_SANDBOX_DEVICE_SERIAL?: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
}

const SYSTEM_PROMPT = `You are Cisco API Navigator, an engineering assistant connected to the official DevNet Content Search MCP server.

You have just received fresh search results from DevNet covering Meraki and Catalyst Center APIs in a <context> block. Treat that block as authoritative. If it answers the user's question, ground your reply in it and cite the operationId or documentation_url where relevant.

RULES:
- Be concise and technical. No filler, no apologies, no "as an AI".
- When showing API usage, prefer fenced code blocks with a language tag (\`\`\`bash, \`\`\`python, \`\`\`json, \`\`\`http).
- Show realistic curl / Python (requests) / JavaScript (fetch) examples when an API is discussed, using the exact method + path from the spec.
- If the context is empty or unrelated, say so plainly and suggest a more specific query — do not invent endpoints.
- Use markdown: short headings, bullet lists, tables only when they earn their keep.
- Never wrap your entire reply in a single code block.`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    if (url.pathname === "/api/mcp-status") {
      return handleMcpStatus(env);
    }

    if (url.pathname === "/api/sandbox-info") {
      return handleSandboxInfo(env);
    }

    if (url.pathname === "/api/sandbox-call" && request.method === "POST") {
      return handleSandboxCall(request, env);
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, model: env.AI_MODEL });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const SANDBOX_BASE_DEFAULT = "https://api.meraki.com/api/v1";
const SANDBOX_NAME_DEFAULT = "Cisco DevNet Always-On Sandbox";
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

function sandboxConfig(env: Env) {
  return {
    name: env.MERAKI_SANDBOX_NAME || SANDBOX_NAME_DEFAULT,
    base: (env.MERAKI_SANDBOX_BASE || SANDBOX_BASE_DEFAULT).replace(/\/$/, ""),
    orgId: env.MERAKI_SANDBOX_ORG_ID || "",
    networkId: env.MERAKI_SANDBOX_NETWORK_ID || "",
    serial: env.MERAKI_SANDBOX_DEVICE_SERIAL || "",
    hasKey: Boolean(env.MERAKI_SANDBOX_API_KEY),
  };
}

async function handleSandboxInfo(env: Env): Promise<Response> {
  const cfg = sandboxConfig(env);
  return Response.json(
    {
      name: cfg.name,
      base: cfg.base,
      orgId: cfg.orgId || null,
      networkId: cfg.networkId || null,
      serial: cfg.serial || null,
      hasServerKey: cfg.hasKey,
      placeholders: {
        "{organizationId}": cfg.orgId || null,
        "{orgId}": cfg.orgId || null,
        "{networkId}": cfg.networkId || null,
        "{netId}": cfg.networkId || null,
        "{serial}": cfg.serial || null,
      },
      docsUrl: "https://developer.cisco.com/meraki/sandbox/",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface SandboxCallBody {
  method?: string;
  path?: string;
  body?: unknown;
}

async function handleSandboxCall(request: Request, env: Env): Promise<Response> {
  let payload: SandboxCallBody;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const method = (payload.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return Response.json({ error: `method ${method} not allowed` }, { status: 400 });
  }

  if (!payload.path || typeof payload.path !== "string") {
    return Response.json({ error: "path is required" }, { status: 400 });
  }

  const cfg = sandboxConfig(env);
  const userKey = request.headers.get("x-user-meraki-key")?.trim();
  const apiKey = userKey || env.MERAKI_SANDBOX_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error:
          "no Meraki API key configured. Set MERAKI_SANDBOX_API_KEY via `wrangler secret put`, or paste your own key in the Link Org panel.",
      },
      { status: 503 },
    );
  }

  const placeholders: Record<string, string> = {};
  if (cfg.orgId) {
    placeholders["{organizationId}"] = cfg.orgId;
    placeholders["{orgId}"] = cfg.orgId;
  }
  if (cfg.networkId) {
    placeholders["{networkId}"] = cfg.networkId;
    placeholders["{netId}"] = cfg.networkId;
  }
  if (cfg.serial) {
    placeholders["{serial}"] = cfg.serial;
  }

  const { resolvedPath, missing } = resolvePath(payload.path, placeholders);
  if (missing.length > 0) {
    return Response.json(
      {
        error: `path needs values not configured for this sandbox: ${missing.join(", ")}`,
        unresolved: missing,
      },
      { status: 422 },
    );
  }

  if (!resolvedPath.startsWith("/api/v1/") && !resolvedPath.startsWith("/v1/")) {
    return Response.json(
      { error: "only /api/v1/* paths are permitted" },
      { status: 400 },
    );
  }

  const targetUrl = cfg.base + resolvedPath.replace(/^\/api\/v1/, "").replace(/^\/v1/, "");
  const sentAt = Date.now();

  const init: RequestInit = {
    method,
    headers: {
      "X-Cisco-Meraki-API-Key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "cisco-api-navigator/0.1",
    },
  };
  if (payload.body !== undefined && method !== "GET" && method !== "DELETE") {
    init.body = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body);
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, init);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const elapsedMs = Date.now() - sentAt;
  const respText = await response.text();
  let respBody: unknown = respText;
  try {
    respBody = JSON.parse(respText);
  } catch {
    /* keep raw */
  }

  const interestingHeaders: Record<string, string> = {};
  for (const h of ["content-type", "x-request-id", "retry-after"]) {
    const v = response.headers.get(h);
    if (v) interestingHeaders[h] = v;
  }

  return Response.json({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    elapsedMs,
    method,
    url: targetUrl,
    headers: interestingHeaders,
    body: respBody,
    usedUserKey: Boolean(userKey),
  });
}

function resolvePath(
  rawPath: string,
  placeholders: Record<string, string>,
): { resolvedPath: string; missing: string[] } {
  let path = rawPath.trim();
  // Drop fully-qualified URLs
  path = path.replace(/^https?:\/\/[^/]+/i, "");
  if (!path.startsWith("/")) path = "/" + path;
  // Strip query for safety on substitution; reattach later
  const qIdx = path.indexOf("?");
  const query = qIdx >= 0 ? path.slice(qIdx) : "";
  let basePath = qIdx >= 0 ? path.slice(0, qIdx) : path;

  for (const [token, value] of Object.entries(placeholders)) {
    if (value) basePath = basePath.split(token).join(value);
  }

  const missingMatches = basePath.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) ?? [];
  const missing = [...new Set(missingMatches)];

  return { resolvedPath: basePath + query, missing };
}

async function handleMcpStatus(env: Env): Promise<Response> {
  const checkedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const session = await openMcpSession(env.MCP_URL);
    const initLatency = Date.now() - start;

    const listStart = Date.now();
    const listRes = await mcpRequest(env.MCP_URL, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listLatency = Date.now() - listStart;

    const tools =
      (listRes?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools
        ?.map((t) => t.name)
        .filter((n): n is string => typeof n === "string") ?? [];

    const totalLatency = Date.now() - start;

    return Response.json(
      {
        ok: tools.length > 0,
        checkedAt,
        latencyMs: totalLatency,
        initLatencyMs: initLatency,
        listLatencyMs: listLatency,
        tools,
        toolCount: tools.length,
      },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (err) {
    return Response.json(
      {
        ok: false,
        checkedAt,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
      {
        status: 200,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: ChatRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return Response.json({ error: "No user message" }, { status: 400 });
  }

  const keyword = lastUser.content.slice(0, 500);

  const [merakiResults, catalystResults] = await Promise.all([
    callMcpTool(env.MCP_URL, "Meraki-API-Doc-Search", {
      keyword,
      return_api_only: false,
      top_k: 3,
    }).catch((e) => ({ error: String(e) })),
    callMcpTool(env.MCP_URL, "CatalystCenter-API-Doc-Search", {
      keyword,
      return_api_only: false,
      top_k: 3,
    }).catch((e) => ({ error: String(e) })),
  ]);

  const contextBlock = formatContext(merakiResults, catalystResults);

  const aiMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.slice(0, -1).slice(-8),
    {
      role: "user",
      content: `<context>\n${contextBlock}\n</context>\n\nUser question: ${lastUser.content}`,
    },
  ];

  const stream = (await env.AI.run(env.AI_MODEL as keyof AiModels, {
    messages: aiMessages,
    stream: true,
    max_tokens: 1500,
  } as never)) as ReadableStream;

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-mcp-meraki-hits": String(extractHitCount(merakiResults)),
      "x-mcp-catalyst-hits": String(extractHitCount(catalystResults)),
    },
  });
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: { result?: unknown[] };
  isError?: boolean;
  error?: string;
}

type McpSession = Record<string, string>;

async function openMcpSession(mcpUrl: string): Promise<McpSession> {
  const headers: McpSession = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  const initRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "devnet-mcp", version: "0.1.0" },
      },
    }),
  });

  if (!initRes.ok) {
    throw new Error(`initialize failed: HTTP ${initRes.status}`);
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  if (sessionId) headers["mcp-session-id"] = sessionId;

  await readMcpBody(initRes);

  if (sessionId) {
    await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    }).catch(() => {});
  }

  return headers;
}

async function mcpRequest(
  mcpUrl: string,
  session: McpSession,
  payload: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: session,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`MCP request failed: HTTP ${res.status}`);
  }
  return readMcpBody(res);
}

async function callMcpTool(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const session = await openMcpSession(mcpUrl);
  const parsed = await mcpRequest(mcpUrl, session, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  return (parsed?.result as McpToolResult) ?? { error: "no result" };
}

async function readMcpBody(res: Response): Promise<{ result?: unknown } | null> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text) return null;

  if (ct.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          return JSON.parse(data);
        } catch {
          /* keep scanning */
        }
      }
    }
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractHitCount(result: McpToolResult | { error: string }): number {
  if ("error" in result && result.error) return 0;
  const r = result as McpToolResult;
  return r.structuredContent?.result?.length ?? 0;
}

function formatContext(
  meraki: McpToolResult | { error: string },
  catalyst: McpToolResult | { error: string },
): string {
  const parts: string[] = [];

  parts.push("## Meraki search results");
  parts.push(formatToolResult(meraki));
  parts.push("");
  parts.push("## Catalyst Center search results");
  parts.push(formatToolResult(catalyst));

  return parts.join("\n");
}

function formatToolResult(result: McpToolResult | { error: string }): string {
  if ("error" in result && result.error) {
    return `(search failed: ${result.error})`;
  }
  const r = result as McpToolResult;
  const items = r.structuredContent?.result;
  if (!items || items.length === 0) {
    const fallback = r.content?.[0]?.text;
    return fallback ? fallback.slice(0, 2000) : "(no results)";
  }

  return items
    .map((raw, i) => {
      const item = raw as Record<string, unknown>;
      const lines: string[] = [`### Result ${i + 1}: ${item.name ?? "(unnamed)"}`];
      if (item.description) lines.push(`Description: ${item.description}`);
      if (item.api_method && item.api_path) {
        lines.push(`Endpoint: ${String(item.api_method).toUpperCase()} ${item.api_path}`);
      }
      if (item.api_operation_id) lines.push(`OperationId: ${item.api_operation_id}`);
      if (item.documentation_url) lines.push(`Docs: ${item.documentation_url}`);
      if (item.tags && Array.isArray(item.tags)) lines.push(`Tags: ${item.tags.join(", ")}`);
      if (item.openapi_specification) {
        const spec = String(item.openapi_specification).slice(0, 1500);
        lines.push(`Spec (truncated):\n${spec}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
