# DevNet Copilot

A beautiful chat interface for Cisco's [DevNet Content Search MCP server](https://github.com/CiscoDevNet/devnet-content-search-mcp), running on Cloudflare Workers + Workers AI.

> Live: **https://devnet-api.clydeford.net**

Ask anything about Cisco APIs and get a streamed, code-formatted answer grounded in real Meraki and Catalyst Center documentation. Every reply is backed by a fresh search of Cisco's hosted MCP server, so endpoints, operation IDs, and OpenAPI specs come straight from the source.

## What it does

- Each user message triggers parallel calls to the official DevNet MCP tools:
  - `Meraki-API-Doc-Search`
  - `CatalystCenter-API-Doc-Search`
- Results are stuffed into the prompt as structured context.
- A small Workers AI model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default) writes the conversational reply, citing operation IDs and doc URLs.
- The response streams token-by-token to the browser over SSE.

## UI features

- **Meraki-flavoured dark theme** — cyan / blue / purple accents with subtle radial glows.
- **Code blocks with copy buttons** — language tag in the header, syntax highlighting via highlight.js, one-click copy.
- **Creative typing indicator** — bouncing router / switch / access point / cloud icons (no boring dots) while the MCP search runs.
- **Smart auto-scroll** — sticks to the bottom while streaming; if you scroll up to read, it stops fighting you.
- **Export chat** — downloads the conversation as Markdown.
- **Clear chat** — confirm-then-wipe, persisted in `localStorage`.
- **Keyboard-first** — Enter to send, Shift+Enter for newline.
- **Suggestion chips** — prefilled prompts to get started.
- **Mobile responsive** — works fine on phones.

## Stack

| Layer       | Tech                                                                 |
| ----------- | -------------------------------------------------------------------- |
| Runtime     | Cloudflare Workers                                                   |
| LLM         | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`              |
| Knowledge   | Cisco DevNet MCP server (hosted, public)                             |
| Frontend    | Vanilla JS + `marked` + `highlight.js` + `DOMPurify` (all CDN)       |
| Styling     | Hand-rolled CSS, Inter + JetBrains Mono                              |
| Static      | Workers Static Assets (no separate CDN, no bundler)                  |

## Project layout

```
.
├── src/
│   └── index.ts          # Worker entry: /api/chat, MCP client, AI streaming
├── public/
│   ├── index.html        # Chat shell
│   ├── styles.css        # Meraki theme + animations
│   └── app.js            # Chat client (streaming, markdown, copy, export)
├── wrangler.jsonc        # Worker config + AI binding + custom domain
├── package.json
├── tsconfig.json
└── README.md
```

## Local development

```bash
npm install
npx wrangler dev
```

Then open `http://localhost:8787`. The dev server proxies Workers AI through your account, so the chat works locally exactly like prod.

## Deployment

Once authenticated to Cloudflare:

```bash
npx wrangler deploy
```

The custom domain `devnet-api.clydeford.net` is declared in `wrangler.jsonc` — Wrangler will attach it on first deploy as long as `clydeford.net` lives on this Cloudflare account.

To swap models, edit `vars.AI_MODEL` in `wrangler.jsonc`. Any Workers AI text-generation model with streaming will work.

## How it works (short version)

```
                  ┌────────────────────────────────────┐
 user prompt ───▶ │  Cloudflare Worker (/api/chat)     │
                  │                                    │
                  │   ① POST tools/call ×2 in parallel │ ──▶ devnet.cisco.com MCP
                  │   ② build <context> block          │
                  │   ③ env.AI.run(model, stream:true) │ ──▶ Workers AI
                  │   ④ pipe SSE to client             │
                  └──────────────┬─────────────────────┘
                                 ▼
                        token-stream → browser
                        (markdown rendered as it arrives,
                         code blocks decorated, smart-scroll)
```

The MCP transport handshake (initialize → notifications/initialized → tools/call) is implemented inline in `src/index.ts` against the streamable-HTTP transport — no SDK required.

## Configuration knobs

All in `wrangler.jsonc` under `vars`:

- `MCP_URL` — defaults to Cisco's public MCP endpoint.
- `AI_MODEL` — any Workers AI text model that supports streaming.

## License

MIT. Cisco DevNet content fetched at runtime is governed by Cisco's own terms — see the [upstream project](https://github.com/CiscoDevNet/devnet-content-search-mcp).
