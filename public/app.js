/* Cisco API Navigator — chat client */


const MAX_HISTORY = 30;

const els = {
  messages: document.getElementById("messages"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("sendBtn"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
};

let history = [];

// Drop any pre-existing chat history from older builds so refresh = clean.
try {
  localStorage.removeItem("devnet-chat-history-v1");
} catch {}
let streaming = false;
let userScrolled = false;

/* --------- markdown rendering --------- */

marked.setOptions({
  breaks: true,
  gfm: true,
});

function renderMarkdown(text) {
  const dirty = marked.parse(text || "");
  return DOMPurify.sanitize(dirty, {
    ADD_ATTR: ["target"],
  });
}

function highlightAll(scope) {
  scope.querySelectorAll("pre code").forEach((block) => {
    if (block.dataset.highlighted) return;
    try {
      hljs.highlightElement(block);
      block.dataset.highlighted = "1";
    } catch {}
  });
}

function decorateCodeBlocks(scope) {
  scope.querySelectorAll("pre").forEach((pre) => {
    if (pre.dataset.decorated) return;
    pre.dataset.decorated = "1";

    const code = pre.querySelector("code");
    const lang =
      [...(code?.classList ?? [])]
        .find((c) => c.startsWith("language-"))
        ?.replace("language-", "") ?? "text";

    const header = document.createElement("div");
    header.className = "code-header";

    const langSpan = document.createElement("span");
    langSpan.textContent = lang;
    header.appendChild(langSpan);

    const headerActions = document.createElement("span");
    headerActions.style.display = "inline-flex";
    headerActions.style.gap = "6px";
    headerActions.style.alignItems = "center";

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.type = "button";
    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>copy</span>`;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code?.textContent ?? "");
        copyBtn.classList.add("copied");
        copyBtn.querySelector("span").textContent = "copied";
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.querySelector("span").textContent = "copy";
        }, 1400);
      } catch {
        copyBtn.querySelector("span").textContent = "failed";
      }
    });

    const merakiCall = code ? detectMerakiCall(code.textContent ?? "") : null;
    const isScriptLang = lang === "python" || lang === "py";
    if (merakiCall && !isScriptLang) {
      const testBtn = makeTestBtn(merakiCall, pre);
      headerActions.appendChild(testBtn);
    }
    headerActions.appendChild(copyBtn);
    header.appendChild(headerActions);

    pre.insertBefore(header, pre.firstChild);
  });
}

/* --------- Meraki call detection --------- */

const MERAKI_PATH_HINTS = [
  /\/(?:organizations|networks|devices|admins|licenses|inventoryDevices|merakiAuthUsers|wireless|switch|appliance|camera|cellularGateway|sensor|sm|insight)\b/,
];

/**
 * Deterministic Meraki path normalizer. Meraki URLs follow a strict
 * resource/{id}/sub-resource pattern, so we don't need to guess what
 * counts as an "example ID" — the segment after a known resource name
 * IS the ID for that resource. Force every such segment to its
 * placeholder unless it already is one. The runtime then substitutes
 * the user's linked DEV/PROD value.
 *
 *   /organizations/{X}/...  → X becomes {organizationId}
 *   /networks/{X}/...       → X becomes {networkId}
 *   /devices/{X}/...        → X becomes {serial}
 *
 * Already-templated segments ({networkId}, {organization_id}, etc.)
 * are left untouched.
 */
function normalizeMerakiPath(path) {
  // Strip query before substituting to avoid touching values inside
  const qIdx = path.indexOf("?");
  const query = qIdx >= 0 ? path.slice(qIdx) : "";
  let base = qIdx >= 0 ? path.slice(0, qIdx) : path;

  base = base
    .replace(/\/organizations\/(?!\{)[^/]+/g, "/organizations/{organizationId}")
    .replace(/\/networks\/(?!\{)[^/]+/g, "/networks/{networkId}")
    .replace(/\/devices\/(?!\{)[^/]+/g, "/devices/{serial}");

  return base + query;
}

function detectMerakiCall(text) {
  if (!text || text.length > 20_000) return null;

  let path = null;

  const fullUrl = text.match(/https?:\/\/api\.meraki\.com(\/[^\s'"`)\\<>]+)/i);
  if (fullUrl) path = fullUrl[1];

  if (!path) {
    const quoted = text.match(/['"`](\/api\/v1\/[^'"`\s]+)['"`]/);
    if (quoted) path = quoted[1];
  }

  if (!path) {
    const quotedShort = text.match(/['"`](\/(?:organizations|networks|devices|admins)[^'"`\s]+)['"`]/);
    if (quotedShort) path = quotedShort[1];
  }

  if (!path) return null;

  if (!path.startsWith("/api/v1") && !path.startsWith("/v1")) {
    if (MERAKI_PATH_HINTS.some((re) => re.test(path))) {
      path = "/api/v1" + path;
    } else {
      return null;
    }
  }

  let method = "GET";
  const m =
    text.match(/(?:--request|-X)\s+["']?(GET|POST|PUT|DELETE|PATCH)["']?/i) ||
    text.match(/requests\.(get|post|put|delete|patch)\b/i) ||
    text.match(/\.(get|post|put|delete|patch)\(/i) ||
    text.match(/method\s*[:=]\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i) ||
    text.match(/^\s*(GET|POST|PUT|DELETE|PATCH)\s+\//im);
  if (m) method = m[1].toUpperCase();

  let body = null;
  const dataMatch =
    text.match(/(?:--data-raw|--data|-d)\s+(['"])([\s\S]+?)\1/) ||
    text.match(/json\s*=\s*(\{[\s\S]*?\})\s*[,)]/) ||
    text.match(/data\s*=\s*(\{[\s\S]*?\})\s*[,)]/);
  if (dataMatch) {
    const raw = dataMatch[2] ?? dataMatch[1];
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  return { method, path, body };
}

function makeTestBtn(call, preEl) {
  const btn = document.createElement("button");
  btn.className = "test-btn";
  btn.type = "button";
  btn.dataset.env = "dev";
  btn.title = `Push ${call.method} ${call.path} to the DEV sandbox`;
  btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Push to DEV</span>`;

  btn.addEventListener("click", () => runPush(call, preEl, "dev", btn));

  return btn;
}

async function runPush(call, preEl, env, triggerBtn) {
  // Rewrite path placeholders BEFORE anything else so the prod confirm
  // dialog and the response panel both reflect what will actually be sent.
  const normalizedCall = { ...call, path: normalizeMerakiPath(call.path) };

  if (env === "prod") {
    const prodReady = Boolean(linkOrg.info?.slots?.prod?.ready);
    if (!prodReady) {
      openLinkModal();
      return;
    }
    const ok = await confirmProdPush(normalizedCall);
    if (!ok) return;
  }

  if (triggerBtn) {
    triggerBtn.classList.add("running");
    const label = triggerBtn.querySelector("span");
    if (label) label.dataset.prev = label.textContent;
    if (label) label.textContent = "running…";
  }

  if (!preEl.dataset.testKey) {
    preEl.dataset.testKey = `sr-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Remove any prior response panel for this env+code-block (keep the other env's panel)
  const existing = preEl.parentNode.querySelector(
    `.sandbox-response[data-pre="${preEl.dataset.testKey}"][data-env="${env}"]`,
  );
  if (existing) existing.remove();

  try {
    const o = linkOrg.overrides?.[env] ?? {};
    const headers = { "content-type": "application/json" };
    if (o.key) headers["x-user-meraki-key"] = o.key;
    if (o.org) headers["x-user-meraki-org"] = o.org;
    if (o.net) headers["x-user-meraki-network"] = o.net;

    const r = await fetch("/api/sandbox-call", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...normalizedCall, env }),
    });
    const data = await r.json();
    renderSandboxResponse(preEl, normalizedCall, data, r.status, env);
  } catch (err) {
    renderSandboxResponse(
      preEl,
      normalizedCall,
      { error: err?.message ?? String(err) },
      0,
      env,
    );
  } finally {
    if (triggerBtn) {
      triggerBtn.classList.remove("running");
      const label = triggerBtn.querySelector("span");
      if (label && label.dataset.prev) {
        label.textContent = label.dataset.prev;
        delete label.dataset.prev;
      }
    }
  }
}

function renderSandboxResponse(preEl, call, data, httpStatus, env) {
  const wrap = document.createElement("div");
  wrap.className = "sandbox-response";
  wrap.dataset.env = env;
  wrap.dataset.pre = preEl.dataset.testKey;

  const head = document.createElement("div");
  head.className = "sr-head";

  const envBadge = document.createElement("span");
  envBadge.className = "sr-env";
  envBadge.dataset.env = env;
  envBadge.textContent = env.toUpperCase();

  const method = document.createElement("span");
  method.className = "sr-method";
  method.textContent = data.method ?? call.method;

  const path = document.createElement("span");
  path.className = "sr-path";
  path.textContent = data.url
    ? data.url.replace(/^https?:\/\/api\.meraki\.com/, "")
    : call.path;

  const status = document.createElement("span");
  status.className = "sr-status";
  const ok = data.ok === true && !data.error;
  status.dataset.status = ok ? "ok" : "err";
  if (data.status) status.textContent = `${data.status} ${data.statusText ?? ""}`.trim();
  else if (data.error) status.textContent = "error";
  else status.textContent = `HTTP ${httpStatus}`;

  const time = document.createElement("span");
  time.className = "sr-time";
  if (typeof data.elapsedMs === "number") time.textContent = `${data.elapsedMs} ms`;

  // Promote-to-PROD button — only on a successful DEV response
  let promoteBtn = null;
  if (env === "dev" && ok) {
    promoteBtn = document.createElement("button");
    promoteBtn.className = "sr-promote";
    promoteBtn.type = "button";
    const prodNetName = linkOrg.info?.slots?.prod?.networkName ?? "PROD";
    promoteBtn.title = `Run the same call against ${prodNetName}`;
    promoteBtn.innerHTML = `<span>Push to PROD</span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
    promoteBtn.addEventListener("click", () => {
      runPush(call, preEl, "prod", promoteBtn);
    });
  }

  const close = document.createElement("button");
  close.className = "sr-close";
  close.type = "button";
  close.innerHTML = "&times;";
  close.addEventListener("click", () => wrap.remove());

  head.append(envBadge, method, path, status, time);
  if (promoteBtn) head.append(promoteBtn);
  head.append(close);

  const body = document.createElement("div");
  body.className = "sr-body";

  if (data.error && !data.body) {
    const errEl = document.createElement("div");
    errEl.className = "sr-error";
    errEl.textContent =
      data.error + (data.unresolved ? `\nUnresolved: ${data.unresolved.join(", ")}` : "");
    body.appendChild(errEl);
  } else {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-json";
    const payload = data.body ?? data;
    code.textContent =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    pre.appendChild(code);
    body.appendChild(pre);
    try {
      hljs.highlightElement(code);
    } catch {}
  }

  wrap.append(head, body);

  // Append PROD panel after DEV panel (don't replace), and before any subsequent panels
  const existingDev = preEl.parentNode.querySelector(
    `.sandbox-response[data-pre="${preEl.dataset.testKey}"][data-env="dev"]`,
  );
  if (env === "prod" && existingDev) {
    existingDev.after(wrap);
  } else {
    preEl.after(wrap);
  }
}

/* --------- message DOM --------- */

function makeAvatar(role) {
  const a = document.createElement("div");
  a.className = "avatar";
  if (role === "user") {
    a.textContent = "you";
    a.style.fontSize = "10px";
  } else {
    a.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
  }
  return a;
}

function createMessageEl(role, content = "") {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;
  wrap.appendChild(makeAvatar(role));

  const body = document.createElement("div");
  body.className = "message-body";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "you" : "Cisco API Navigator";
  body.appendChild(meta);

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  if (role === "user") {
    contentEl.textContent = content;
  } else {
    contentEl.innerHTML = renderMarkdown(content);
    decorateCodeBlocks(contentEl);
    highlightAll(contentEl);
  }
  body.appendChild(contentEl);

  wrap.appendChild(body);
  return { wrap, contentEl };
}

function renderHistory() {
  els.messages.innerHTML = "";
  if (history.length === 0) {
    showWelcome();
    return;
  }
  for (const m of history) {
    const { wrap } = createMessageEl(m.role, m.content);
    els.messages.appendChild(wrap);
  }
  scrollToBottom(true);
}

function showWelcome() {
  const welcome = document.createElement("div");
  welcome.className = "welcome";
  welcome.innerHTML = `
    <div class="welcome-card">
      <h2>Ask anything about Cisco APIs.</h2>
      <p>Connected live to Cisco's DevNet MCP server. Replies cite real operation IDs and doc URLs.</p>
      <div class="suggestions">
        <button class="chip">Show L3 firewall rules config for Meraki</button>
        <button class="chip">Find OAuth setup for Meraki APIs</button>
        <button class="chip">Catalyst Center device inventory APIs</button>
        <button class="chip">Spec for createNetworkMerakiAuthUser</button>
      </div>
    </div>`;
  els.messages.appendChild(welcome);
  bindChips();
}

function bindChips() {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      els.input.value = chip.textContent;
      els.input.focus();
      autoresize();
    });
  });
}

/* --------- typing indicator --------- */

const ICONS = {
  router: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="13" width="18" height="6" rx="1.5"/><circle cx="7" cy="16" r="1" fill="#0a1929"/><circle cx="10" cy="16" r="1" fill="#0a1929"/><path d="M12 13V8m0 0l-3-3m3 3l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`,
  switch: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2.5" y="9" width="19" height="6" rx="1.5"/><circle cx="6" cy="12" r="0.9" fill="#0a1929"/><circle cx="9" cy="12" r="0.9" fill="#0a1929"/><circle cx="12" cy="12" r="0.9" fill="#0a1929"/><circle cx="15" cy="12" r="0.9" fill="#0a1929"/><circle cx="18" cy="12" r="0.9" fill="#0a1929"/></svg>`,
  ap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12a7 7 0 0 1 14 0"/><path d="M8 14a4 4 0 0 1 8 0"/><circle cx="12" cy="16" r="1.4" fill="currentColor"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 18h10a4 4 0 0 0 .9-7.9A6 6 0 0 0 5.6 11 4 4 0 0 0 7 18z"/></svg>`,
};

function makeTypingEl() {
  const wrap = document.createElement("div");
  wrap.className = "message assistant typing-message";
  wrap.appendChild(makeAvatar("assistant"));

  const body = document.createElement("div");
  body.className = "message-body";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = "Cisco API Navigator";
  body.appendChild(meta);

  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = `
    <div class="typing-icons">${ICONS.router}${ICONS.switch}${ICONS.ap}${ICONS.cloud}</div>
    <span class="typing-text">searching DevNet</span>`;
  body.appendChild(typing);

  wrap.appendChild(body);
  return wrap;
}

/* --------- scroll behaviour --------- */

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  return scrollHeight - (scrollTop + clientHeight) < 80;
}

function scrollToBottom(force = false) {
  if (force || !userScrolled) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

els.messages.addEventListener("scroll", () => {
  userScrolled = !isNearBottom();
});

/* --------- chat send --------- */

async function send(text) {
  if (!text.trim() || streaming) return;
  streaming = true;
  els.sendBtn.disabled = true;

  const welcomeEl = els.messages.querySelector(".welcome");
  if (welcomeEl) welcomeEl.remove();

  history.push({ role: "user", content: text });
  saveHistory();

  const { wrap: userEl } = createMessageEl("user", text);
  els.messages.appendChild(userEl);

  const typing = makeTypingEl();
  els.messages.appendChild(typing);
  userScrolled = false;
  scrollToBottom(true);

  els.input.value = "";
  autoresize();

  const { wrap: assistantEl, contentEl: assistantContent } = createMessageEl(
    "assistant",
    "",
  );

  let buffer = "";
  let renderTimer = null;
  let typingReplaced = false;

  const renderTick = () => {
    assistantContent.innerHTML = renderMarkdown(buffer);
    decorateCodeBlocks(assistantContent);
    highlightAll(assistantContent);
    scrollToBottom();
    renderTimer = null;
  };

  const queueRender = () => {
    if (renderTimer == null) {
      renderTimer = setTimeout(renderTick, 60);
    }
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });

      const lines = raw.split("\n");
      raw = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        if (!typingReplaced) {
          typing.replaceWith(assistantEl);
          typingReplaced = true;
        }

        try {
          const obj = JSON.parse(payload);
          const delta = obj.response ?? obj.content ?? "";
          if (delta) {
            buffer += delta;
            queueRender();
          }
        } catch {
          buffer += payload;
          queueRender();
        }
      }
    }

    if (!typingReplaced) {
      typing.replaceWith(assistantEl);
    }
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTick();
    } else {
      renderTick();
    }

    if (buffer.trim()) {
      history.push({ role: "assistant", content: buffer });
      saveHistory();
    }
  } catch (err) {
    if (typing.parentNode) typing.remove();
    if (!assistantEl.parentNode) els.messages.appendChild(assistantEl);
    assistantContent.innerHTML = renderMarkdown(
      `**Something went wrong.** \n\n\`\`\`\n${err?.message ?? err}\n\`\`\``,
    );
    decorateCodeBlocks(assistantContent);
    highlightAll(assistantContent);
  } finally {
    streaming = false;
    els.sendBtn.disabled = false;
    els.input.focus();
  }
}

/* --------- export / clear --------- */

function exportChat() {
  if (history.length === 0) {
    flashStatus("nothing to export");
    return;
  }
  const lines = ["# Cisco API Navigator chat", ""];
  for (const m of history) {
    lines.push(`## ${m.role === "user" ? "You" : "Cisco API Navigator"}`);
    lines.push("");
    lines.push(m.content);
    lines.push("");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `devnet-chat-${stamp}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearChat() {
  if (history.length === 0) return;
  if (!confirm("Clear the conversation? This can't be undone.")) return;
  history = [];
  saveHistory();
  renderHistory();
}

function flashStatus(text) {
  /* no-op: status pill now drives MCP health, transient toasts replaced by inline UI */
  console.log("[status]", text);
}

/* --------- MCP health --------- */

const DEGRADED_MS = 2500;
const POLL_MS = 60_000;

const health = {
  el: els.status,
  popover: document.getElementById("healthPopover"),
  refreshBtn: document.getElementById("hpRefresh"),
  state: document.getElementById("hpState"),
  endpoint: document.getElementById("hpEndpoint"),
  latency: document.getElementById("hpLatency"),
  toolCount: document.getElementById("hpToolCount"),
  tools: document.getElementById("hpTools"),
  checked: document.getElementById("hpChecked"),
  error: document.getElementById("hpError"),
  dot: els.status.querySelector(".dot"),
  text: els.status.querySelector(".status-text"),
};

let healthTimer = null;
let healthInflight = false;
let lastHealth = null;

const STATE_LABEL = {
  connected: "Connected",
  degraded: "Degraded",
  offline: "Offline",
  checking: "Checking…",
};

function setHealthState(state, data) {
  ["connected", "degraded", "offline", "checking"].forEach((s) => {
    health.el.classList.toggle(s, s === state);
    health.popover.classList.toggle(s, s === state);
  });
  health.text.textContent = state === "checking" ? "checking" : state;
  health.state.textContent = STATE_LABEL[state] ?? state;

  if (data) {
    health.endpoint.textContent = "devnet.cisco.com/v1/foundation-search-mcp";
    health.latency.textContent =
      typeof data.latencyMs === "number" ? `${data.latencyMs} ms` : "—";
    const tools = Array.isArray(data.tools) ? data.tools : [];
    health.toolCount.textContent = tools.length
      ? `${tools.length} available`
      : data.toolCount
        ? `${data.toolCount} available`
        : "—";
    health.tools.innerHTML = "";
    tools.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      health.tools.appendChild(li);
    });
    health.checked.textContent = data.checkedAt
      ? formatRelative(new Date(data.checkedAt))
      : "—";

    if (data.error) {
      health.error.hidden = false;
      health.error.textContent = data.error;
    } else {
      health.error.hidden = true;
      health.error.textContent = "";
    }
  }

  const verb = state === "connected" ? "MCP connected" : state === "degraded" ? "MCP degraded" : state === "offline" ? "MCP offline" : "Checking MCP…";
  health.el.title = data?.latencyMs ? `${verb} · ${data.latencyMs}ms` : verb;
  health.el.setAttribute("aria-expanded", health.popover.hidden ? "false" : "true");
}

function formatRelative(date) {
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return date.toLocaleTimeString();
}

async function checkMcpHealth() {
  if (healthInflight) return;
  healthInflight = true;
  health.refreshBtn.classList.add("spinning");
  if (!lastHealth) setHealthState("checking");

  try {
    const r = await fetch("/api/mcp-status", { cache: "no-store" });
    const data = await r.json();
    lastHealth = data;

    let state;
    if (!data.ok) state = "offline";
    else if ((data.latencyMs ?? 0) > DEGRADED_MS) state = "degraded";
    else state = "connected";

    setHealthState(state, data);
  } catch (err) {
    lastHealth = {
      ok: false,
      error: err?.message ?? String(err),
      checkedAt: new Date().toISOString(),
    };
    setHealthState("offline", lastHealth);
  } finally {
    healthInflight = false;
    health.refreshBtn.classList.remove("spinning");
  }
}

function startHealthPolling() {
  if (healthTimer) return;
  checkMcpHealth();
  healthTimer = setInterval(() => {
    if (document.visibilityState === "visible") checkMcpHealth();
  }, POLL_MS);
}

function togglePopover(force) {
  const willShow = typeof force === "boolean" ? force : health.popover.hidden;
  health.popover.hidden = !willShow;
  health.el.setAttribute("aria-expanded", willShow ? "true" : "false");
  if (willShow && lastHealth) {
    health.checked.textContent = lastHealth.checkedAt
      ? formatRelative(new Date(lastHealth.checkedAt))
      : "—";
  }
}

health.el.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePopover();
});

health.refreshBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  checkMcpHealth();
});

document.addEventListener("click", (e) => {
  if (health.popover.hidden) return;
  if (!health.popover.contains(e.target) && !health.el.contains(e.target)) {
    togglePopover(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !health.popover.hidden) togglePopover(false);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkMcpHealth();
});

startHealthPolling();

/* --------- in-memory history (refresh = clean slate) --------- */

function saveHistory() {
  // History lives only in memory; just trim to the cap.
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
}

/* --------- composer behaviour --------- */

function autoresize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
}

els.input.addEventListener("input", autoresize);

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  send(text);
});

els.exportBtn.addEventListener("click", exportChat);
els.clearBtn.addEventListener("click", clearChat);

/* --------- Link Org / DEV+PROD slot config --------- */

const OVERRIDES_KEY = "devnet-slot-overrides-v1";

const linkOrg = {
  info: null,
  overrides: { dev: { key: "", org: "", net: "" }, prod: { key: "", org: "", net: "" } },
};

function loadOverrides() {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveOverridesToStorage() {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(linkOrg.overrides));
  } catch {}
}

function slotDefaults(envName) {
  const orgId = linkOrg.info?.orgId ?? "";
  const slot = linkOrg.info?.slots?.[envName] ?? {};
  return {
    org: orgId,
    net: slot.networkId ?? "",
  };
}

function effectiveSlot(envName) {
  const o = linkOrg.overrides[envName] ?? { key: "", org: "", net: "" };
  const d = slotDefaults(envName);
  return {
    key: o.key || "",
    org: o.org || d.org,
    net: o.net || d.net,
    keyOverridden: Boolean(o.key),
    orgOverridden: Boolean(o.org),
    netOverridden: Boolean(o.net),
  };
}

const modalEls = {
  btn: document.getElementById("linkOrgBtn"),
  pill: document.getElementById("linkOrgPill"),
  modal: document.getElementById("linkOrgModal"),
  orgLine: document.getElementById("modalOrgLine"),
  // DEV card
  sandboxCard: document.getElementById("sandboxCard"),
  sandboxName: document.getElementById("sandboxName"),
  sandboxNetName: document.getElementById("sandboxNetName"),
  sandboxPill: document.getElementById("sandboxPill"),
  // PROD card
  prodCard: document.getElementById("prodCard"),
  prodName: document.getElementById("prodName"),
  prodNetName: document.getElementById("prodNetName"),
  prodPill: document.getElementById("prodPill"),
};

function applyLinkState() {
  const dev = linkOrg.info?.slots?.dev;
  const prod = linkOrg.info?.slots?.prod;

  const devReady = Boolean(dev?.ready);
  const prodReady = Boolean(prod?.ready);

  // Top button pill — only show when something needs attention
  if (!devReady && !prodReady) {
    modalEls.pill.hidden = false;
    modalEls.pill.textContent = "set up";
    modalEls.btn.dataset.mode = "missing";
  } else if (!prodReady) {
    modalEls.pill.hidden = false;
    modalEls.pill.textContent = "PROD missing";
    modalEls.btn.dataset.mode = "missing";
  } else {
    modalEls.pill.hidden = true;
    modalEls.btn.dataset.mode = "dev";
  }

  modalEls.sandboxCard.dataset.active = devReady ? "true" : "false";
  modalEls.prodCard.dataset.active = prodReady ? "true" : "false";
  modalEls.sandboxPill.hidden = !devReady;
  modalEls.prodPill.hidden = !prodReady;
}

async function fetchSandboxInfo() {
  try {
    const r = await fetch("/api/sandbox-info", { cache: "no-store" });
    linkOrg.info = await r.json();
  } catch (err) {
    linkOrg.info = { error: err?.message ?? String(err) };
  }

  if (linkOrg.info && !linkOrg.info.error) {
    const orgId = linkOrg.info.orgId ?? "—";
    const dev = linkOrg.info.slots?.dev ?? {};
    const prod = linkOrg.info.slots?.prod ?? {};

    modalEls.orgLine.textContent =
      orgId !== "—" ? `Server: org ${orgId} · ${(linkOrg.info.base ?? "").replace(/^https?:\/\//, "")}` : "";

    modalEls.sandboxName.textContent = dev.name ?? "Your development org";
    modalEls.sandboxNetName.textContent = dev.networkName ?? "—";

    modalEls.prodName.textContent = prod.name ?? "Your production org";
    modalEls.prodNetName.textContent = prod.networkName ?? "—";

    paintSlotInputs();
  }

  applyLinkState();
}

function inputsForSlot(envName) {
  return {
    key: modalEls.modal.querySelector(`input[data-slot="${envName}"][data-field="key"]`),
    org: modalEls.modal.querySelector(`input[data-slot="${envName}"][data-field="org"]`),
    net: modalEls.modal.querySelector(`input[data-slot="${envName}"][data-field="net"]`),
  };
}

function paintSlotInputs() {
  for (const envName of ["dev", "prod"]) {
    const inputs = inputsForSlot(envName);
    const o = linkOrg.overrides[envName] ?? { key: "", org: "", net: "" };
    const d = slotDefaults(envName);
    if (inputs.key) {
      inputs.key.value = o.key;
      inputs.key.placeholder = linkOrg.info?.hasServerKey
        ? "server default (configured)"
        : "no server key — override required";
    }
    if (inputs.org) {
      inputs.org.value = o.org;
      inputs.org.placeholder = d.org || "—";
    }
    if (inputs.net) {
      inputs.net.value = o.net;
      inputs.net.placeholder = d.net || "—";
    }
  }
}

function openLinkModal() {
  paintSlotInputs();
  modalEls.modal.hidden = false;
}

function closeLinkModal() {
  modalEls.modal.hidden = true;
  modalEls.modal.querySelectorAll(".slot-test-result").forEach((el) => {
    el.hidden = true;
    el.removeAttribute("data-state");
    el.textContent = "";
  });
}

modalEls.btn.addEventListener("click", openLinkModal);
modalEls.modal.querySelectorAll("[data-modal-close]").forEach((el) => {
  el.addEventListener("click", closeLinkModal);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalEls.modal.hidden) closeLinkModal();
});

modalEls.modal.querySelectorAll("[data-action='save']").forEach((btn) => {
  btn.addEventListener("click", () => {
    const envName = btn.dataset.slot;
    const inputs = inputsForSlot(envName);
    linkOrg.overrides[envName] = {
      key: inputs.key.value.trim(),
      org: inputs.org.value.trim(),
      net: inputs.net.value.trim(),
    };
    saveOverridesToStorage();
    flashOverride(btn, "saved");
    applyLinkState();
  });
});

modalEls.modal.querySelectorAll("[data-action='reset']").forEach((btn) => {
  btn.addEventListener("click", () => {
    const envName = btn.dataset.slot;
    linkOrg.overrides[envName] = { key: "", org: "", net: "" };
    saveOverridesToStorage();
    paintSlotInputs();
    flashOverride(btn, "reset");
    applyLinkState();
  });
});

modalEls.modal.querySelectorAll("[data-action='test']").forEach((btn) => {
  btn.addEventListener("click", () => testSlotConnection(btn));
});

async function testSlotConnection(btn) {
  if (btn.classList.contains("running")) return;
  const envName = btn.dataset.slot;
  const resultEl = modalEls.modal.querySelector(
    `.slot-test-result[data-slot="${envName}"]`,
  );

  // Pull the current input values (live, not yet saved) so the user can
  // verify edits before saving them.
  const inputs = inputsForSlot(envName);
  const liveOverrides = {
    key: inputs.key.value.trim(),
    org: inputs.org.value.trim(),
    net: inputs.net.value.trim(),
  };

  btn.classList.add("running");
  setSlotResult(resultEl, "checking", "checking…");

  try {
    const headers = { "content-type": "application/json" };
    if (liveOverrides.key) headers["x-user-meraki-key"] = liveOverrides.key;
    if (liveOverrides.org) headers["x-user-meraki-org"] = liveOverrides.org;
    if (liveOverrides.net) headers["x-user-meraki-network"] = liveOverrides.net;

    const r = await fetch("/api/sandbox-call", {
      method: "POST",
      headers,
      body: JSON.stringify({
        env: envName,
        method: "GET",
        path: "/api/v1/networks/{networkId}",
      }),
    });
    const data = await r.json();

    if (data.ok && data.body && typeof data.body === "object") {
      const name = data.body.name ?? data.networkId;
      setSlotResult(
        resultEl,
        "ok",
        `200 OK · ${name} · ${data.elapsedMs ?? "?"} ms`,
      );
    } else if (data.error) {
      setSlotResult(resultEl, "err", data.error);
    } else {
      const status = data.status ? `${data.status} ${data.statusText ?? ""}`.trim() : "error";
      const detail =
        typeof data.body === "object" && data.body?.errors
          ? data.body.errors.join("; ")
          : typeof data.body === "string"
            ? data.body.slice(0, 120)
            : status;
      setSlotResult(resultEl, "err", `${status} · ${detail}`);
    }
  } catch (err) {
    setSlotResult(resultEl, "err", err?.message ?? String(err));
  } finally {
    btn.classList.remove("running");
  }
}

function setSlotResult(el, state, detail) {
  if (!el) return;
  el.hidden = false;
  el.dataset.state = state;
  el.innerHTML = `<span class="stres-dot"></span><span class="stres-detail"></span>`;
  el.querySelector(".stres-detail").textContent = detail;
}

function flashOverride(btn, label) {
  const span = btn.querySelector("span") || btn;
  const prev = span.textContent;
  span.textContent = label;
  setTimeout(() => {
    span.textContent = prev;
  }, 1200);
}

const storedOverrides = loadOverrides();
if (storedOverrides) {
  if (storedOverrides.dev) linkOrg.overrides.dev = { key: "", org: "", net: "", ...storedOverrides.dev };
  if (storedOverrides.prod) linkOrg.overrides.prod = { key: "", org: "", net: "", ...storedOverrides.prod };
}

fetchSandboxInfo();

/* --------- PROD push confirmation modal --------- */

const prodModalEls = {
  modal: document.getElementById("prodPushModal"),
  method: document.getElementById("prodModalMethod"),
  path: document.getElementById("prodModalPath"),
  net: document.getElementById("prodModalNetwork"),
  netId: document.getElementById("prodModalNetworkId"),
  notice: document.getElementById("prodCrNotice"),
  cancel: document.getElementById("prodCancelBtn"),
  cr: document.getElementById("prodChangeRequestBtn"),
  confirm: document.getElementById("prodConfirmBtn"),
};

let prodResolver = null;

function confirmProdPush(call) {
  return new Promise((resolve) => {
    prodResolver = resolve;
    prodModalEls.method.textContent = call.method ?? "GET";
    prodModalEls.path.textContent = call.path ?? "—";

    const prodSlot = linkOrg.info?.slots?.prod ?? {};
    prodModalEls.net.textContent = prodSlot.networkName ?? "PROD network";
    prodModalEls.netId.textContent = prodSlot.networkId ?? "—";

    prodModalEls.notice.hidden = true;
    prodModalEls.modal.hidden = false;
    // Default focus to Cancel for safety — Enter shouldn't push.
    prodModalEls.cancel.focus();
  });
}

function closeProdModal(result) {
  prodModalEls.modal.hidden = true;
  if (prodResolver) {
    prodResolver(result);
    prodResolver = null;
  }
}

prodModalEls.modal.querySelectorAll("[data-modal-close]").forEach((el) => {
  el.addEventListener("click", () => closeProdModal(false));
});
prodModalEls.cancel.addEventListener("click", () => closeProdModal(false));
prodModalEls.confirm.addEventListener("click", () => closeProdModal(true));
prodModalEls.cr.addEventListener("click", () => {
  // Unwired stub — surface a notice and keep the modal open so the user
  // can choose between cancel and "push with no change request".
  prodModalEls.notice.hidden = false;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !prodModalEls.modal.hidden) {
    closeProdModal(false);
  }
});

/* --------- init --------- */

renderHistory();
bindChips();
els.input.focus();
