/* Cisco API Navigator — chat client */


const STORAGE_KEY = "devnet-chat-history-v1";
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

let history = loadHistory();
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
    if (merakiCall) {
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
  if (env === "prod" && !linkOrg.byokKey) {
    openLinkModal();
    return;
  }
  if (env === "prod") {
    const confirmMsg = `Push ${call.method} ${call.path}\n\nto your PROD Meraki dashboard?\n\nReads are safe; writes change live config.`;
    if (!confirm(confirmMsg)) return;
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
    const headers = { "content-type": "application/json" };
    if (env === "prod") {
      headers["x-user-meraki-key"] = linkOrg.byokKey;
      if (linkOrg.byokOrg) headers["x-user-meraki-org"] = linkOrg.byokOrg;
      if (linkOrg.byokNet) headers["x-user-meraki-network"] = linkOrg.byokNet;
    }
    const r = await fetch("/api/sandbox-call", {
      method: "POST",
      headers,
      body: JSON.stringify(call),
    });
    const data = await r.json();
    renderSandboxResponse(preEl, call, data, r.status, env);
  } catch (err) {
    renderSandboxResponse(
      preEl,
      call,
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
    promoteBtn.title = linkOrg.byokKey
      ? "Run the same call against your PROD org"
      : "Link a PROD org first";
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

/* --------- storage --------- */

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    const trimmed = history.slice(-MAX_HISTORY);
    history = trimmed;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {}
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

/* --------- Link Org / sandbox config --------- */

const BYOK_KEY = "devnet-byok-v1";

const linkOrg = {
  info: null,
  mode: "sandbox", // "sandbox" | "byok"
  byokKey: "",
  byokOrg: "",
  byokNet: "",
};

const modalEls = {
  btn: document.getElementById("linkOrgBtn"),
  pill: document.getElementById("linkOrgPill"),
  modal: document.getElementById("linkOrgModal"),
  sandboxCard: document.getElementById("sandboxCard"),
  sandboxName: document.getElementById("sandboxName"),
  sandboxBase: document.getElementById("sandboxBase"),
  sandboxOrg: document.getElementById("sandboxOrg"),
  sandboxNet: document.getElementById("sandboxNet"),
  sandboxKey: document.getElementById("sandboxKey"),
  sandboxPill: document.getElementById("sandboxPill"),
  useSandboxBtn: document.getElementById("useSandboxBtn"),
  byokCard: document.getElementById("byokCard"),
  byokKey: document.getElementById("byokKey"),
  byokOrg: document.getElementById("byokOrg"),
  byokNet: document.getElementById("byokNet"),
  byokPill: document.getElementById("byokPill"),
  saveByokBtn: document.getElementById("saveByokBtn"),
  clearByokBtn: document.getElementById("clearByokBtn"),
};

function loadByok() {
  try {
    const raw = localStorage.getItem(BYOK_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveByok() {
  if (linkOrg.byokKey) {
    localStorage.setItem(
      BYOK_KEY,
      JSON.stringify({
        key: linkOrg.byokKey,
        org: linkOrg.byokOrg,
        net: linkOrg.byokNet,
      }),
    );
  } else {
    localStorage.removeItem(BYOK_KEY);
  }
}

function applyLinkState() {
  const devLinked = Boolean(linkOrg.info?.hasServerKey);
  const prodLinked = Boolean(linkOrg.byokKey);

  // Top button pill: hidden in default DEV-only state, shown for PROD or missing
  if (!devLinked && !prodLinked) {
    modalEls.pill.hidden = false;
    modalEls.pill.textContent = "set up";
    modalEls.btn.dataset.mode = "missing";
  } else if (devLinked && prodLinked) {
    modalEls.pill.hidden = false;
    modalEls.pill.textContent = "PROD";
    modalEls.btn.dataset.mode = "prod";
  } else if (prodLinked) {
    modalEls.pill.hidden = false;
    modalEls.pill.textContent = "PROD";
    modalEls.btn.dataset.mode = "prod";
  } else {
    modalEls.pill.hidden = true;
    modalEls.btn.dataset.mode = "dev";
  }

  // Card linked/active markers
  modalEls.sandboxCard.dataset.active = devLinked ? "true" : "false";
  modalEls.byokCard.dataset.active = prodLinked ? "true" : "false";
  modalEls.sandboxPill.hidden = !devLinked;
  modalEls.sandboxPill.textContent = "linked";
  modalEls.byokPill.hidden = !prodLinked;
  modalEls.byokPill.textContent = "linked";

  // Existing PROD-promote buttons reflect current PROD-link state
  document.querySelectorAll(".sr-promote").forEach((btn) => {
    btn.title = prodLinked
      ? "Run the same call against your PROD org"
      : "Link a PROD org first";
  });
}

async function fetchSandboxInfo() {
  try {
    const r = await fetch("/api/sandbox-info", { cache: "no-store" });
    linkOrg.info = await r.json();
  } catch (err) {
    linkOrg.info = { error: err?.message ?? String(err) };
  }

  if (linkOrg.info && !linkOrg.info.error) {
    modalEls.sandboxName.textContent = linkOrg.info.name ?? "Cisco DevNet Sandbox";
    modalEls.sandboxBase.textContent = (linkOrg.info.base ?? "").replace(/^https?:\/\//, "");
    modalEls.sandboxOrg.textContent = linkOrg.info.orgId ?? "—";
    modalEls.sandboxNet.textContent = linkOrg.info.networkId ?? "—";
    if (linkOrg.info.hasServerKey) {
      modalEls.sandboxKey.textContent = "configured";
      modalEls.sandboxKey.dataset.state = "ok";
    } else {
      modalEls.sandboxKey.textContent = "not configured";
      modalEls.sandboxKey.dataset.state = "missing";
    }
  }

  applyLinkState();
}

function openLinkModal() {
  modalEls.modal.hidden = false;
  modalEls.byokKey.value = linkOrg.byokKey;
  modalEls.byokOrg.value = linkOrg.byokOrg;
  modalEls.byokNet.value = linkOrg.byokNet;
  applyLinkState();
}

function closeLinkModal() {
  modalEls.modal.hidden = true;
}

modalEls.btn.addEventListener("click", openLinkModal);
modalEls.modal.querySelectorAll("[data-modal-close]").forEach((el) => {
  el.addEventListener("click", closeLinkModal);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalEls.modal.hidden) closeLinkModal();
});

modalEls.useSandboxBtn.addEventListener("click", () => {
  closeLinkModal();
});

modalEls.saveByokBtn.addEventListener("click", () => {
  const key = modalEls.byokKey.value.trim();
  if (!key) {
    modalEls.byokKey.focus();
    return;
  }
  linkOrg.byokKey = key;
  linkOrg.byokOrg = modalEls.byokOrg.value.trim();
  linkOrg.byokNet = modalEls.byokNet.value.trim();
  saveByok();
  applyLinkState();
  closeLinkModal();
});

modalEls.clearByokBtn.addEventListener("click", () => {
  linkOrg.byokKey = "";
  linkOrg.byokOrg = "";
  linkOrg.byokNet = "";
  modalEls.byokKey.value = "";
  modalEls.byokOrg.value = "";
  modalEls.byokNet.value = "";
  saveByok();
  applyLinkState();
});

/* Hydrate BYOK from storage */
const stored = loadByok();
if (stored?.key) {
  linkOrg.byokKey = stored.key;
  linkOrg.byokOrg = stored.org ?? "";
  linkOrg.byokNet = stored.net ?? "";
}

fetchSandboxInfo();

/* --------- init --------- */

renderHistory();
bindChips();
els.input.focus();
