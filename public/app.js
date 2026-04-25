/* DevNet Copilot — chat client */

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
    header.appendChild(copyBtn);

    pre.insertBefore(header, pre.firstChild);
  });
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
  meta.textContent = role === "user" ? "you" : "DevNet Copilot";
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
  meta.textContent = "DevNet Copilot";
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
  const lines = ["# DevNet Copilot chat", ""];
  for (const m of history) {
    lines.push(`## ${m.role === "user" ? "You" : "DevNet Copilot"}`);
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
  const el = els.status.querySelector(".status-text");
  const prev = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = prev), 1400);
}

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

/* --------- init --------- */

renderHistory();
bindChips();
els.input.focus();
