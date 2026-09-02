// MCP (Model Context Protocol) client plumbing: session lifecycle
// (open/use/close) and the tools/call helpers built on top of it.
//
// A "session" is just the set of HTTP headers to send on every subsequent
// request (including, once assigned, the `mcp-session-id` header returned
// by `initialize`). Opening a session performs the full handshake
// (`initialize` POST + `notifications/initialized` POST); reusing an
// open session for multiple tool calls skips that handshake entirely.

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: { result?: unknown[] };
  isError?: boolean;
  error?: string;
}

export type McpSession = Record<string, string>;

export async function openMcpSession(mcpUrl: string): Promise<McpSession> {
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

export async function mcpRequest(
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

// Calls a tool over an already-open MCP session, skipping the
// initialize/notifications-initialized handshake. Callers that share one
// session across multiple tool calls should pass a distinct `id` per call
// (JSON-RPC ids should be unique within a session).
export async function callMcpToolWithSession(
  mcpUrl: string,
  session: McpSession,
  toolName: string,
  args: Record<string, unknown>,
  id: number = 2,
): Promise<McpToolResult> {
  const parsed = await mcpRequest(mcpUrl, session, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  return (parsed?.result as McpToolResult) ?? { error: "no result" };
}

export async function callMcpTool(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const session = await openMcpSession(mcpUrl);
  return callMcpToolWithSession(mcpUrl, session, toolName, args);
}

// Best-effort termination of an MCP session (HTTP DELETE per the
// Streamable HTTP transport). Never throws — a failed/unsupported
// termination should not break the caller's response.
export async function closeMcpSession(mcpUrl: string, session: McpSession): Promise<void> {
  if (!session["mcp-session-id"]) return;
  try {
    await fetch(mcpUrl, {
      method: "DELETE",
      headers: session,
    });
  } catch {
    /* best effort */
  }
}

// Runs both DevNet doc searches (Meraki + Catalyst Center) over a single
// shared MCP session instead of each opening its own — one initialize
// handshake per chat request instead of two. The session is always closed
// once both searches have settled, even if one (or both) threw; a failure
// opening the session itself degrades to empty results rather than failing
// the caller's request.
export async function runMcpSearches(
  mcpUrl: string,
  keyword: string,
): Promise<{
  merakiResults: McpToolResult | { error: string };
  catalystResults: McpToolResult | { error: string };
}> {
  let session: McpSession;
  try {
    session = await openMcpSession(mcpUrl);
  } catch (e) {
    const error = { error: String(e) };
    return { merakiResults: error, catalystResults: error };
  }

  try {
    const [merakiResults, catalystResults] = await Promise.all([
      callMcpToolWithSession(
        mcpUrl,
        session,
        "Meraki-API-Doc-Search",
        { keyword, return_api_only: false, top_k: 3 },
        2,
      ).catch((e) => ({ error: String(e) })),
      callMcpToolWithSession(
        mcpUrl,
        session,
        "CatalystCenter-API-Doc-Search",
        { keyword, return_api_only: false, top_k: 3 },
        3,
      ).catch((e) => ({ error: String(e) })),
    ]);
    return { merakiResults, catalystResults };
  } finally {
    await closeMcpSession(mcpUrl, session);
  }
}

export async function readMcpBody(res: Response): Promise<{ result?: unknown } | null> {
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
