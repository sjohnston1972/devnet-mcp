# Deterministic snippet builder — design

Date: 2026-06-12 · Approved in conversation (user: "implement the deterministic snippet builder")

## Problem

The DevNet MCP server returns documentation (method, path, operationId, OpenAPI excerpt),
never runnable code. The chat model (llama-3.3-70b) composes curl snippets freehand from
that context, which produced a stream of push failures: `#` comments inside JSON, dangling
members, broken quoting, and wrong-endpoint choices. The client-side tolerant parser
patches syntax, but generation should be right at the source.

## Approach (chosen)

Build the curl snippet **deterministically in the worker** from each Meraki MCP hit and
inject it into the model's context; instruct the model to reproduce it verbatim, changing
only JSON values. The model stops writing curl/JSON structure entirely.

Alternatives considered:
- Post-process the model's output (rewrite its code blocks): fragile, fights the stream.
- Structured tool-calling so the model never emits code: larger rework of the chat flow,
  and Workers AI streaming + tool use is awkward; not needed to kill this bug class.

## Evidence (probe of live MCP server, tests/e2e-mcp-probe.mjs)

- Each hit has `api_method`, `api_path` (templated, e.g.
  `/networks/{networkId}/appliance/firewall/l3FirewallRules`), `products`,
  `openapi_specification`, `documentation_url`.
- `openapi_specification` is YAML-flow-ish text (unquoted keys/scalars), NOT valid JSON.
  Schema descriptions contain commas/colons — full parsing is unreliable.
- The `requestBody` section contains `example: {…}` with simple scalars only — reliably
  machine-parseable with a small relaxed-flow parser.

## Components

**`src/snippet-builder.ts`** (pure, unit-tested):
- `parseRelaxedFlow(text)` — parses `{key: value, …}` / `[…]` flow syntax with unquoted
  scalars. Scalars run until `,`/`}`/`]` at depth 0; segments without a `:` are appended to
  the previous scalar (handles comma-separated values like `"80,443"`). Types `true`/
  `false`/`null`/numbers.
- `extractRequestExample(spec)` — locates `requestBody`…`example:` before `responses:`,
  brace-matches the object, parses it. Returns null when absent or unparseable.
- `buildCurlSnippet({ method, path, spec, base })` — emits the canonical curl: `-X`,
  templated URL (`base + path`), Content-Type + `X-Cisco-Meraki-API-Key: YOUR_API_KEY`
  headers, and `-d '<pretty JSON example>'` for write methods when an example exists.
  GET/DELETE get no body.

**`src/index.ts` integration:**
- `formatToolResult(result, snippetBase)` — for Meraki results (`snippetBase` set), append
  per hit: `Example request (generated from the spec):` + bash-fenced snippet. Catalyst
  results pass `null` (different base URL/auth; Push targets Meraki only).
- `SYSTEM_PROMPT` — new rule: when a result includes an "Example request" snippet, copy it
  verbatim as the code example; change only JSON values; never add comments or restructure.

## Data flow

MCP hit → worker builds snippet → context → model copies + fills values → client
`detectMerakiCall` parses (existing hardened path) → push. The tolerant JSON parser stays
as defense in depth for the model's value edits.

## Error handling

- No `api_method`/`api_path` → no snippet line (status quo context).
- No parseable example on a write op → snippet without `-d`; model fills the body (status
  quo, still benefits from correct endpoint/headers).
- Parser failures must never throw out of `formatToolResult` (wrap, return null).

## Testing

- Unit tests with the two real spec strings captured from the live probe (L3 firewall
  rules incl. nested example; SSID L3 rules) plus edge cases (no requestBody, GET).
- E2E probe: ask the SIP question against local worker; assert the emitted curl matches
  the deterministic skeleton (endpoint, no comments, body parses strictly).
