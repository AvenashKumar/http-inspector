const $ = (id) => document.getElementById(id);
let lastResult = null;
let lastRequest = null;
let inboxId = null;

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("http-inspector-theme", theme); } catch (e) {}
  $("theme-light").classList.toggle("active", theme === "light");
  $("theme-dark").classList.toggle("active", theme === "dark");
  $("theme-light").setAttribute("aria-pressed", theme === "light");
  $("theme-dark").setAttribute("aria-pressed", theme === "dark");
}
function initTheme() {
  const saved = document.documentElement.getAttribute("data-theme") || "light";
  setTheme(saved);
}
$("theme-light").addEventListener("click", () => setTheme("light"));
$("theme-dark").addEventListener("click", () => setTheme("dark"));

function parseHeaders(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    if (i < 0) return null;
    return { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  }).filter(Boolean);
}
function fmtMs(v) { return v == null ? "n/a" : v + " ms"; }
function fmtBytes(v) { return v == null ? "n/a" : v < 1024 ? v + " B" : (v / 1024).toFixed(1) + " KB"; }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

const HISTORY_KEY = "http-inspector-history";
const INBOXES_KEY = "http-inspector-inboxes";
function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
}
function saveHistory(result) {
  try {
    const list = readHistory().filter((x) => x.id !== result.id);
    list.unshift(result);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 50)));
  } catch (e) {}
}
function mediaPreviewHtml(r) {
  const url = esc(r.previewUrl || r.url || "");
  const links = `<p><a href="${url}" target="_blank" rel="noopener">Open original</a> , <a href="${url}" download>Download</a></p>`;
  if (r.mediaType === "image") return `<img src="${url}" alt="Preview of ${url}" style="max-width:100%;height:auto;border-radius:8px">` + links;
  if (r.mediaType === "audio") return `<audio controls src="${url}" style="width:100%"></audio>` + links;
  if (r.mediaType === "video") return `<video controls src="${url}" style="max-width:100%"></video>` + links;
  if (r.mediaType === "pdf") return `<embed src="${url}" type="application/pdf" style="width:100%;height:480px;border-radius:8px">` + links;
  if (r.mediaType === "binary") return `<p>Binary content (${esc(r.contentType || "unknown type")}, ${fmtBytes(r.sizeBytes)}). Shown as a preview link, not as text.</p>` + links;
  return `<pre class="tab-body">${esc(r.body || r.error || "Empty body.")}</pre>`;
}

function loadHistory() {
  const list = readHistory();
  $("history").innerHTML = list.length ? list.map((x) => `
    <details class="hook-item history-item" data-id="${esc(x.id)}">
      <summary><strong>${x.status || "error"}</strong> ${esc(x.method)} ${esc(x.url)} , ${new Date(x.createdAt).toLocaleString()} , ${fmtMs(x.totalMs)}</summary>
      <div class="history-detail"><p><strong>Status:</strong> ${x.status || "error"} ${esc(x.statusText || "")} , <strong>TTFB:</strong> ${fmtMs(x.ttfbMs)} , <strong>Total:</strong> ${fmtMs(x.totalMs)} , <strong>Size:</strong> ${fmtBytes(x.sizeBytes)} , <strong>Content type:</strong> ${esc(x.contentType || "n/a")}</p><p class="muted">Redirects</p><pre class="tab-body">${esc((x.redirects && x.redirects.length) ? x.redirects.map((r) => `${r.status} -> ${r.location} (${r.ms} ms)`).join("\n") : "No redirects followed.")}</pre><p class="muted">Headers</p><pre class="tab-body">${esc((x.headers || []).map((h) => `${h.name}: ${h.value}`).join("\n") || "No headers returned.")}</pre><p class="muted">Body</p>${mediaPreviewHtml(x)}</div>
      <button type="button" class="btn btn-secondary inspect-again" data-url="${esc(x.url)}" data-method="${esc(x.method)}">Inspect again</button>
    </details>`).join("") : "<p class='muted'>No inspections yet.</p>";
  $("history").querySelectorAll(".inspect-again").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    $("url").value = b.dataset.url; $("method").value = b.dataset.method;
    $("inspect-form").requestSubmit();
  }));
}
$("clear-history").addEventListener("click", () => { try { localStorage.removeItem(HISTORY_KEY); } catch (e) {} loadHistory(); });

function showResult(r) {
  lastResult = r;
  $("result").classList.remove("hidden");
  $("inspect-error").classList.add("hidden");
  $("r-status").textContent = r.status != null ? r.status : "error";
  $("r-status-text").textContent = r.statusText || "";
  $("r-ttfb").textContent = fmtMs(r.ttfbMs);
  $("r-total").textContent = fmtMs(r.totalMs);
  $("r-size").textContent = fmtBytes(r.sizeBytes);
  $("r-type").textContent = r.contentType || "n/a";
  $("r-verdict").textContent = r.verdict || (r.error ? r.error : "");
  const t = r.timing || {};
  const max = Math.max(t.totalMs || 1, 1);
  const bar = (label, ms) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><div class="bar-fill ${ms == null ? "na" : ""}" style="width:${ms == null ? 100 : Math.max(2, (ms / max) * 100)}%"></div></div><span>${fmtMs(ms)}</span></div>`;
  $("waterfall").innerHTML = bar("DNS", null) + bar("TCP", null) + bar("TLS", null) + bar("TTFB", t.ttfbMs) + bar("Download", t.downloadMs) + bar("Total", t.totalMs);
  $("tab-headers").textContent = (r.headers || []).map((h) => `${h.name}: ${h.value}`).join("\n") || "No headers returned.";
  $("tab-body").innerHTML = mediaPreviewHtml(r);
  $("tab-tls").textContent = r.tls ? r.tls.note : "TLS details are not available from the Worker.";
  $("tab-redirects").textContent = (r.redirects && r.redirects.length) ? r.redirects.map((x) => `${x.status} -> ${x.location} (${x.ms} ms)`).join("\n") : "No redirects followed.";
  $("tab-cookies").textContent = (r.cookies && r.cookies.length) ? r.cookies.join("\n") : "No set-cookie headers.";
}

$("inspect-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const method = $("method").value;
  const url = $("url").value.trim();
  const payload = { method, url, headers: parseHeaders($("headers").value), body: $("body").value || undefined, followRedirects: $("follow").checked, timeoutMs: Number($("timeout").value) };
  lastRequest = payload;
  const btn = $("inspect-btn");
  btn.disabled = true; btn.textContent = "Inspecting...";
  try {
    const r = await fetch("/api/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) { $("result").classList.add("hidden"); $("inspect-error").textContent = d.error || "Inspection failed."; $("inspect-error").classList.remove("hidden"); return; }
    showResult(d);
    saveHistory(d);
    loadHistory();
  } catch (err) {
    $("inspect-error").textContent = "Inspection failed: " + err.message;
    $("inspect-error").classList.remove("hidden");
  } finally { btn.disabled = false; btn.textContent = "Inspect"; }
});

document.querySelectorAll(".examples button").forEach((b) => b.addEventListener("click", () => {
  $("url").value = b.dataset.url;
  $("inspect-form").requestSubmit();
}));

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  const name = t.dataset.tab;
  ["headers", "body", "tls", "redirects", "cookies"].forEach((n) => $("tab-" + n).classList.toggle("hidden", n !== name));
}));

$("copy-curl").addEventListener("click", async () => {
  if (!lastRequest || !lastResult) return;
  let cmd = `curl -X ${lastRequest.method} '${lastRequest.url}'`;
  (lastRequest.headers || []).forEach((h) => { cmd += ` -H '${h.name}: ${h.value}'`; });
  if (lastRequest.body) cmd += ` --data '${lastRequest.body}'`;
  try { await navigator.clipboard.writeText(cmd); $("copy-msg").textContent = "Copied."; } catch (e) { $("copy-msg").textContent = cmd; }
});

$("export-json").addEventListener("click", () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `http-inspector-${lastResult.status || "result"}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $("copy-msg").textContent = "Downloaded.";
});

$("mode-inspect").addEventListener("click", () => {
  $("mode-inspect").classList.add("active"); $("mode-webhook").classList.remove("active");
  $("inspect-pane").classList.remove("hidden"); $("webhook-pane").classList.add("hidden");
  $("history-section").classList.remove("hidden");
});
$("mode-webhook").addEventListener("click", () => {
  $("mode-webhook").classList.add("active"); $("mode-inspect").classList.remove("active");
  $("webhook-pane").classList.remove("hidden"); $("inspect-pane").classList.add("hidden");
  $("history-section").classList.add("hidden");
});

function readInboxes() {
  try { return JSON.parse(localStorage.getItem(INBOXES_KEY) || "[]"); } catch (e) { return []; }
}
function saveInbox(entry) {
  try {
    const list = readInboxes().filter((x) => x.id !== entry.id);
    list.unshift(entry);
    localStorage.setItem(INBOXES_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (e) {}
}
function removeInbox(id) {
  try { localStorage.setItem(INBOXES_KEY, JSON.stringify(readInboxes().filter((x) => x.id !== id))); } catch (e) {}
}
function loadInboxList() {
  const list = readInboxes();
  $("inbox-list").innerHTML = list.length ? list.map((x) => {
    const expired = Date.now() > (x.expiresAt || 0);
    return `<div class="history-row">
      <strong>${esc(x.id)}</strong>
      <span class="muted">${expired ? "Expired" : "Expires " + new Date(x.expiresAt).toLocaleString()}</span>
      <button type="button" data-open="${esc(x.id)}">Open</button>
      <button type="button" data-forget="${esc(x.id)}">Forget</button>
    </div>`;
  }).join("") : "<p class='muted'>No inboxes yet in this browser.</p>";
  $("inbox-list").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openInbox(b.dataset.open)));
  $("inbox-list").querySelectorAll("[data-forget]").forEach((b) => b.addEventListener("click", () => { removeInbox(b.dataset.forget); loadInboxList(); }));
}
function inboxIdFromInput(raw) {
  const m = String(raw || "").trim().match(/\/hook\/([A-Za-z0-9_-]{1,64})/);
  if (m) return m[1];
  return String(raw || "").trim();
}
async function openInbox(raw) {
  const id = inboxIdFromInput(raw);
  // A ?inbox= link always lands on the Webhook Inbox tab, never on Inspect.
  $("mode-webhook").click();
  $("open-inbox-error").classList.add("hidden");
  if (!id) return;
  const r = await fetch(`/api/webhooks/${encodeURIComponent(id)}`);
  if (!r.ok) {
    $("open-inbox-error").textContent = "Inbox not found or expired. Check the ID or endpoint and try again.";
    $("open-inbox-error").classList.remove("hidden");
    return;
  }
  const meta = await r.json();
  inboxId = meta.id;
  $("inbox").classList.remove("hidden");
  $("inbox-url").textContent = `${location.origin}/hook/${meta.id}`;
  $("inbox-meta").textContent = `Created ${new Date(meta.createdAt).toLocaleString()}, expires ${new Date(meta.expiresAt).toLocaleString()}.`;
  saveInbox({ id: meta.id, createdAt: meta.createdAt, expiresAt: meta.expiresAt });
  loadInboxList();
  refreshHooks();
}
$("open-inbox").addEventListener("click", () => openInbox($("open-inbox-id").value));

async function refreshHooks() {
  if (!inboxId) return;
  const r = await fetch(`/api/webhooks/${inboxId}/requests`);
  const d = await r.json();
  const list = d.requests || [];
  $("hook-list").innerHTML = list.length ? `<div style="margin:10px 0"><button type="button" class="btn btn-secondary" id="hook-expand-all">Expand all</button> <button type="button" class="btn btn-secondary" id="hook-collapse-all">Collapse all</button></div>` + list.map((x) => {
    let headers = [];
    try { headers = JSON.parse(x.headers_json || "[]"); } catch (e) { headers = []; }
    const headerText = headers.map((h) => `${h.name}: ${h.value}`).join("\n") || "No headers received.";
    return `<details class="hook-item"><summary><strong>${esc(x.method)}</strong> ${esc(x.path || "")} , ${esc(x.source || "")} , ${new Date(x.received_at).toLocaleString()}</summary><p class="muted">Headers</p><pre class="tab-body">${esc(headerText)}</pre><p class="muted">Body</p><pre class="tab-body">${esc(x.body_text || "")}</pre></details>`;
  }).join("") : "<p class='muted'>No requests yet. Send one to the endpoint above.</p>";
  const expandAll = $("hook-expand-all");
  if (expandAll) {
    expandAll.addEventListener("click", () => document.querySelectorAll(".hook-item").forEach((d) => { d.open = true; }));
    $("hook-collapse-all").addEventListener("click", () => document.querySelectorAll(".hook-item").forEach((d) => { d.open = false; }));
  }
}
$("create-inbox").addEventListener("click", async () => {
  const r = await fetch("/api/webhooks", { method: "POST" });
  const d = await r.json();
  inboxId = d.id;
  $("inbox").classList.remove("hidden");
  $("inbox-url").textContent = d.endpoint;
  $("inbox-meta").textContent = `Created ${new Date().toLocaleString()}, expires ${new Date(d.expiresAt).toLocaleString()}.`;
  saveInbox({ id: d.id, createdAt: Date.now(), expiresAt: d.expiresAt });
  loadInboxList();
  refreshHooks();
});
$("copy-inbox").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("inbox-url").textContent); } catch (e) {} });
$("copy-inbox-link").addEventListener("click", async () => {
  if (!inboxId) return;
  try { await navigator.clipboard.writeText(`${location.origin}/?inbox=${inboxId}`); } catch (e) {}
});
$("simulate-hook").addEventListener("click", async () => {
  if (!inboxId) return;
  await fetch(`/api/webhooks/${inboxId}/simulate`, { method: "POST" });
  refreshHooks();
});
$("refresh-hook").addEventListener("click", refreshHooks);

initTheme();
loadHistory();
loadInboxList();
const inboxParam = new URLSearchParams(location.search).get("inbox");
if (inboxParam) openInbox(inboxParam);
