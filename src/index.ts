import Anthropic from "@anthropic-ai/sdk";
import { upstreamBodyFor } from "./upstream-body.ts";
import { buildCurlSnippet } from "./snippet-builder.ts";
import { toAnthropicTurns, buildFallbackMessages } from "./chat-history.ts";
import {
  openMcpSession,
  mcpRequest,
  runMcpSearches,
  type McpToolResult,
} from "./mcp-session.ts";
import { resolvePath } from "./resolve-path.ts";
import {
  checkContentLength,
  readLimitedText,
  validateMessages,
  MAX_BODY_BYTES,
} from "./chat-request-guard.ts";
import { SlidingCounter } from "./rate-limiter.ts";
import { sameOrigin } from "./security.ts";
import {
  resolveTarget,
  isSameOrigin,
  SlidingWindowRateLimiter,
  auditLog,
} from "./sandbox-guard.ts";

interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  MCP_URL: string;
  AI_MODEL: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  MERAKI_SANDBOX_API_KEY?: string;
  MERAKI_SANDBOX_BASE?: string;
  MERAKI_SANDBOX_ORG_ID?: string;
  MERAKI_DEV_NAME?: string;
  MERAKI_DEV_NETWORK_ID?: string;
  MERAKI_DEV_NETWORK_NAME?: string;
  MERAKI_PROD_NAME?: string;
  MERAKI_PROD_NETWORK_ID?: string;
  MERAKI_PROD_NETWORK_NAME?: string;
  MERAKI_DEV_DEVICE_SERIAL?: string;
  MERAKI_PROD_DEVICE_SERIAL?: string;
  CHAT_RATE_LIMIT_PER_MINUTE?: string;
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
- Default ALL code examples to curl with a \`\`\`bash fence. Use the exact method + path from the spec. Only switch to Python (requests) or JavaScript (fetch) if the user explicitly asks for that language.
- When a search result includes an "Example request" snippet, reproduce that snippet EXACTLY as your code example — same endpoint, same headers, same JSON structure, no comments inside the JSON. Change ONLY the JSON values (never the keys) to fit the user's ask. Do not write curl commands from scratch when a snippet is provided.
- For path parameters, ALWAYS use template placeholders: {organizationId}, {networkId}, {serial}. NEVER write literal example IDs like N_123456789, L_646829..., 549236, or any made-up value. The runtime substitutes these placeholders with the user's linked DEV/PROD network at request time, so a literal example ID will hit a non-existent target and 404.
- For the API key in examples, write the literal placeholder YOUR_API_KEY (the runtime injects the real key from a secret — never put a real key in a snippet).
- Meraki syslog flags: "syslogEnabled": true (and "syslogDefaultRule": true) are rejected by Meraki unless the network already has a syslog server configured. Default syslogEnabled to false and omit syslogDefaultRule, unless the user explicitly says they have a syslog server. If the user wants traffic "captured" or "logged", still default to false and note they must configure a syslog server first.
- Meraki MX firewall direction matters: traffic from the LAN out to internet/SaaS destinations (Microsoft 365, SIP trunks, etc.) is OUTBOUND — use updateNetworkApplianceFirewallL3FirewallRules with the external subnets in destCidr. Only use inboundFirewallRules for traffic arriving from the internet; Meraki rejects public subnets in an inbound rule's destCidr (it only accepts local VLAN(n).* destinations or "any").
- If the context is empty or unrelated, say so plainly and suggest a more specific query — do not invent endpoints.
- Use markdown: short headings, bullet lists, tables only when they earn their keep.
- Never wrap your entire reply in a single code block.`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Same-origin gate for every JSON API route (chat, sandbox-call,
    // mcp-status, sandbox-info). Defense-in-depth against browser-driven
    // cross-site abuse; see security.ts for what this does and does not
    // stop. /api/health and static asset serving are intentionally left
    // open (see the PR/issue #8 notes for why).
    if (isApiRoute(url.pathname) && !sameOrigin(request)) {
      return Response.json(
        { error: "cross-origin requests to this API are not allowed" },
        { status: 403 },
      );
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const rate = chatRateHits.check(
        clientIp(request),
        chatRateLimitPerMinute(env),
        RATE_LIMIT_WINDOW_MS,
      );
      if (!rate.allowed) {
        return Response.json(
          { error: "rate limited" },
          {
            status: 429,
            headers: { "retry-after": String(rate.retryAfterSeconds) },
          },
        );
      }
      return handleChat(request, env, ctx);
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
      return Response.json({ ok: true, model: activeModel(env) });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function isApiRoute(pathname: string): boolean {
  return (
    pathname === "/api/chat" ||
    pathname === "/api/sandbox-call" ||
    pathname === "/api/mcp-status" ||
    pathname === "/api/sandbox-info"
  );
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "anon";
}

// Portable in-isolate rate limiter — see rate-limiter.ts for why this is
// approximate rather than a global limit (no Rate Limiting binding or KV
// namespace is configured in wrangler.jsonc for this project).
const chatRateHits = new SlidingCounter();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_DEFAULT_PER_MINUTE = 20;

function chatRateLimitPerMinute(env: Env): number {
  const raw = env.CHAT_RATE_LIMIT_PER_MINUTE;
  if (!raw) return RATE_LIMIT_DEFAULT_PER_MINUTE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : RATE_LIMIT_DEFAULT_PER_MINUTE;
}

const SANDBOX_BASE_DEFAULT = "https://api.meraki.com/api/v1";
const ANTHROPIC_MODEL_DEFAULT = "claude-opus-4-8";

function activeModel(env: Env): string {
  return env.ANTHROPIC_API_KEY
    ? env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULT
    : env.AI_MODEL;
}
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

interface MerakiSlot {
  name: string;
  networkId: string;
  networkName: string;
  serial: string;
}

function merakiBase(env: Env): string {
  return (env.MERAKI_SANDBOX_BASE || SANDBOX_BASE_DEFAULT).replace(/\/$/, "");
}

function merakiOrgId(env: Env): string {
  return env.MERAKI_SANDBOX_ORG_ID || "";
}

function devSlot(env: Env): MerakiSlot {
  return {
    name: env.MERAKI_DEV_NAME || "Development",
    networkId: env.MERAKI_DEV_NETWORK_ID || "",
    networkName: env.MERAKI_DEV_NETWORK_NAME || "",
    serial: env.MERAKI_DEV_DEVICE_SERIAL || "",
  };
}

function prodSlot(env: Env): MerakiSlot {
  return {
    name: env.MERAKI_PROD_NAME || "Production",
    networkId: env.MERAKI_PROD_NETWORK_ID || "",
    networkName: env.MERAKI_PROD_NETWORK_NAME || "",
    serial: env.MERAKI_PROD_DEVICE_SERIAL || "",
  };
}

async function handleSandboxInfo(env: Env): Promise<Response> {
  const orgId = merakiOrgId(env);
  const dev = devSlot(env);
  const prod = prodSlot(env);
  const hasServerKey = Boolean(env.MERAKI_SANDBOX_API_KEY);

  return Response.json(
    {
      base: merakiBase(env),
      orgId: orgId || null,
      hasServerKey,
      slots: {
        dev: {
          name: dev.name,
          networkId: dev.networkId || null,
          networkName: dev.networkName || null,
          ready: hasServerKey && Boolean(orgId) && Boolean(dev.networkId),
        },
        prod: {
          name: prod.name,
          networkId: prod.networkId || null,
          networkName: prod.networkName || null,
          ready: hasServerKey && Boolean(orgId) && Boolean(prod.networkId),
        },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface SandboxCallBody {
  method?: string;
  path?: string;
  body?: unknown;
  env?: "dev" | "prod";
}

// Per-IP sliding-window budgets for /api/sandbox-call (issue #11). Writes
// get a much tighter budget than reads. Module-level singletons: state
// lives for the lifetime of the isolate, which is a reasonable "good
// enough" bound here without adding a Durable Object / KV binding.
const sandboxWriteLimiter = new SlidingWindowRateLimiter(5, 60_000);
const sandboxReadLimiter = new SlidingWindowRateLimiter(30, 60_000);

export async function handleSandboxCall(request: Request, env: Env): Promise<Response> {
  const selfUrl = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";

  // Populated as the request is validated/resolved, so the audit line
  // logged from `finish()` always reflects the fullest context available
  // at the point of refusal or completion.
  let method = "unknown";
  let rawPath = "unknown";
  let targetEnv: "dev" | "prod" | null = null;
  let usingServerKey = false;
  let orgId: string | null = null;
  let netId: string | null = null;

  // Logs one audit line (issue #11: endpoint, resolved target, outcome --
  // never the API key or request/response bodies) and returns the
  // response. Used for every refusal/error exit; the final successful
  // proxy response logs+returns itself since its HTTP status intentionally
  // stays 200 regardless of the upstream status (see below).
  const finish = (status: number, outcome: string, body: Record<string, unknown>): Response => {
    auditLog({
      ts: new Date().toISOString(),
      endpoint: "/api/sandbox-call",
      method,
      path: rawPath,
      env: targetEnv,
      resolvedOrgId: orgId,
      resolvedNetworkId: netId,
      usedServerKey: usingServerKey,
      ip,
      outcome,
      status,
    });
    return Response.json(body, { status });
  };

  let payload: SandboxCallBody;
  try {
    payload = await request.json();
  } catch {
    return finish(400, "invalid-json", { error: "invalid JSON" });
  }

  method = (payload.method || "GET").toUpperCase();
  rawPath = typeof payload.path === "string" ? payload.path : "unknown";

  if (!ALLOWED_METHODS.has(method)) {
    return finish(400, "bad-method", { error: `method ${method} not allowed` });
  }

  if (!payload.path || typeof payload.path !== "string") {
    return finish(400, "missing-path", { error: "path is required" });
  }

  // Issue #11: rate-limit before doing anything else. Writes get a much
  // tighter budget than reads.
  const isWrite = method !== "GET";
  const limiter = isWrite ? sandboxWriteLimiter : sandboxReadLimiter;
  if (!limiter.check(ip)) {
    return finish(429, "rate-limited", { error: "rate limit exceeded, slow down" });
  }

  targetEnv = payload.env === "prod" ? "prod" : "dev";
  const slot = targetEnv === "prod" ? prodSlot(env) : devSlot(env);

  const userKey = request.headers.get("x-user-meraki-key")?.trim();
  const userOrg = request.headers.get("x-user-meraki-org")?.trim();
  const userNet = request.headers.get("x-user-meraki-network")?.trim();
  const userSerial = request.headers.get("x-user-meraki-serial")?.trim();
  const apiKey = userKey || env.MERAKI_SANDBOX_API_KEY;
  usingServerKey = !userKey;

  if (!apiKey) {
    // Fails closed: no key at all (neither the caller's nor the server's
    // configured secret) means no upstream call, full stop.
    return finish(503, "no-key", {
      error:
        "no Meraki API key configured. Set MERAKI_SANDBOX_API_KEY via `wrangler secret put`.",
    });
  }

  // Issue #9: the server's own Meraki key may only ever be driven by the
  // app's own page. A caller bringing their own key is fine -- they can
  // only ever reach their own org with their own credential.
  if (usingServerKey && !isSameOrigin(request, selfUrl)) {
    return finish(403, "denied-origin", {
      error: "cross-origin callers must supply their own x-user-meraki-key",
    });
  }

  // Issue #10: when the server key is in play, x-user-meraki-org /
  // x-user-meraki-network / x-user-meraki-serial must never be able to
  // retarget it. A mismatched override is refused outright here -- never
  // sanitised or silently coerced to the server's value. Do not
  // "simplify" this away.
  const decision = resolveTarget(
    Boolean(userKey),
    { org: userOrg, net: userNet, serial: userSerial },
    { orgId: merakiOrgId(env), networkId: slot.networkId, serial: slot.serial },
  );
  if (!decision.ok) {
    return finish(403, "denied-override", { error: decision.reason ?? "override rejected" });
  }

  orgId = decision.orgId;
  netId = decision.netId;
  const serial = decision.serial;

  const { resolvedPath, missing } = resolvePath(payload.path, { orgId, netId, serial });
  if (missing.length > 0) {
    // Fails closed: an unconfigured org/network slot never falls back to
    // "allow anyway" -- it 422s instead of silently substituting nothing.
    return finish(422, "unresolved", {
      error: `path needs values not configured for this sandbox: ${missing.join(", ")}`,
      unresolved: missing,
    });
  }

  if (!resolvedPath.startsWith("/api/v1/") && !resolvedPath.startsWith("/v1/")) {
    return finish(400, "bad-path-prefix", { error: "only /api/v1/* paths are permitted" });
  }

  const targetUrl = merakiBase(env) + resolvedPath.replace(/^\/api\/v1/, "").replace(/^\/v1/, "");
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
  const upstreamBody = upstreamBodyFor(method, payload.body);
  if (upstreamBody !== undefined) {
    init.body = upstreamBody;
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, init);
  } catch (err) {
    return finish(502, "upstream-error", {
      error: err instanceof Error ? err.message : String(err),
    });
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

  auditLog({
    ts: new Date().toISOString(),
    endpoint: "/api/sandbox-call",
    method,
    path: rawPath,
    env: targetEnv,
    resolvedOrgId: orgId,
    resolvedNetworkId: netId,
    usedServerKey: usingServerKey,
    ip,
    outcome: response.ok ? "ok" : "upstream-error-status",
    status: response.status,
  });

  // Intentionally always HTTP 200 here (matches prior behavior): the real
  // upstream status travels in the JSON body so the app can render
  // Meraki's actual response, including its errors, without the fetch()
  // itself throwing on a non-2xx.
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
    env: targetEnv,
    networkId: netId || null,
  });
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

async function handleChat(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Reject on the declared size before reading anything...
  const lengthCheck = checkContentLength(request.headers.get("content-length"), MAX_BODY_BYTES);
  if (!lengthCheck.ok) {
    return Response.json({ error: lengthCheck.error }, { status: lengthCheck.status });
  }

  // ...and enforce the same cap while streaming the body, since a client can
  // omit or lie about Content-Length. Nothing downstream (MCP, Anthropic,
  // Workers AI) is called until this returns ok.
  const bodyRead = await readLimitedText(request.body, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    return Response.json({ error: bodyRead.error }, { status: bodyRead.status });
  }

  let body: ChatRequest;
  try {
    body = bodyRead.text ? JSON.parse(bodyRead.text) : {};
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messagesCheck = validateMessages(body.messages);
  if (!messagesCheck.ok) {
    return Response.json({ error: messagesCheck.error }, { status: messagesCheck.status });
  }

  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return Response.json({ error: "No user message" }, { status: 400 });
  }

  const keyword = lastUser.content.slice(0, 500);

  const { merakiResults, catalystResults } = await runMcpSearches(env.MCP_URL, keyword);

  const contextBlock = formatContext(merakiResults, catalystResults);
  const finalUserContent = `<context>\n${contextBlock}\n</context>\n\nUser question: ${lastUser.content}`;

  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-model": activeModel(env),
    "x-mcp-meraki-hits": String(extractHitCount(merakiResults)),
    "x-mcp-catalyst-hits": String(extractHitCount(catalystResults)),
  };

  if (env.ANTHROPIC_API_KEY) {
    return claudeChatResponse(env, ctx, messages, finalUserContent, sseHeaders);
  }

  // Fallback: Workers AI (used until an Anthropic key is configured)
  const aiMessages = buildFallbackMessages(
    SYSTEM_PROMPT,
    messages.slice(0, -1),
    finalUserContent,
    8,
  );

  const stream = (await env.AI.run(env.AI_MODEL as keyof AiModels, {
    messages: aiMessages,
    stream: true,
    max_tokens: 1500,
  } as never)) as ReadableStream;

  return new Response(stream, { headers: sseHeaders });
}

/**
 * Stream a Claude reply re-encoded as the `data: {"response": "..."}` SSE
 * lines the browser client already parses (same shape Workers AI emits).
 */
function claudeChatResponse(
  env: Env,
  ctx: ExecutionContext,
  history: ChatMessage[],
  finalUserContent: string,
  headers: Record<string, string>,
): Response {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const turns = toAnthropicTurns(history.slice(0, -1), 8);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (text: string) =>
    writer.write(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));

  const pump = (async () => {
    try {
      const stream = anthropic.messages.stream({
        model: env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULT,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        messages: [...turns, { role: "user", content: finalUserContent }],
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          await send(event.delta.text);
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        await send("\n\n**The model declined this request.**");
      }
    } catch (err) {
      try {
        await send(
          `\n\n**Model error:** ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        /* client gone */
      }
    } finally {
      try {
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
      } catch {
        /* client gone */
      }
    }
  })();
  ctx.waitUntil(pump);

  return new Response(readable, { headers });
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
  parts.push(formatToolResult(meraki, SANDBOX_BASE_DEFAULT));
  parts.push("");
  parts.push("## Catalyst Center search results");
  parts.push(formatToolResult(catalyst, null));

  return parts.join("\n");
}

function formatToolResult(
  result: McpToolResult | { error: string },
  snippetBase: string | null,
): string {
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
      if (snippetBase && item.api_method && item.api_path) {
        try {
          const snippet = buildCurlSnippet({
            method: String(item.api_method),
            path: String(item.api_path),
            spec: item.openapi_specification
              ? String(item.openapi_specification)
              : undefined,
            base: snippetBase,
          });
          lines.push(
            `Example request (reproduce verbatim; change only JSON values):\n\`\`\`bash\n${snippet}\n\`\`\``,
          );
        } catch {
          /* never let snippet generation break context assembly */
        }
      }
      if (item.tags && Array.isArray(item.tags)) lines.push(`Tags: ${item.tags.join(", ")}`);
      if (item.openapi_specification) {
        const spec = String(item.openapi_specification).slice(0, 1500);
        lines.push(`Spec (truncated):\n${spec}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
