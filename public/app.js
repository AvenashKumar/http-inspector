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

async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    const d = await r.json();
    const list = d.inspections || [];
    $("history").innerHTML = list.length ? list.map((x) => `
      <details class="hook-item history-item" data-id="${esc(x.id)}">
        <summary><strong>${x.status || "error"}</strong> ${esc(x.method)} ${esc(x.url)} , ${new Date(x.created_at).toLocaleString()} , ${fmtMs(x.total_ms)}</summary>
        <div class="history-detail"><p class="muted">Loading details...</p></div>
        <button type="button" class="btn btn-secondary inspect-again" data-url="${esc(x.url)}" data-method="${esc(x.method)}">Inspect again</button>
      </details>`).join("") : "<p class='muted'>No inspections yet.</p>";
    $("history").querySelectorAll(".inspect-again").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      $("url").value = b.dataset.url; $("method").value = b.dataset.method;
      $("inspect-form").requestSubmit();
    }));
    $("history").querySelectorAll(".history-item").forEach((el) => el.addEventListener("toggle", async () => {
      if (!el.open || el.dataset.loaded) return;
      el.dataset.loaded = "1";
      const detail = el.querySelector(".history-detail");
      try {
        const res = await fetch(`/api/inspect/${el.dataset.id}`);
        const full = await res.json();
        if (!res.ok) { detail.innerHTML = "<p class='muted'>Details could not be loaded.</p>"; return; }
        let headers = [];
        try { headers = JSON.parse(full.headers_json || "[]"); } catch (e) { headers = []; }
        const headerText = headers.map((h) => `${h.name}: ${h.value}`).join("\n") || "No headers returned.";
        let redirects = [];
        try { redirects = JSON.parse(full.redirects_json || "[]"); } catch (e) { redirects = []; }
        detail.innerHTML = `<p><strong>Status:</strong> ${full.status || "error"} ${esc(full.status_text || "")} , <strong>TTFB:</strong> ${fmtMs(full.ttfb_ms)} , <strong>Total:</strong> ${fmtMs(full.total_ms)} , <strong>Size:</strong> ${fmtBytes(full.size_bytes)} , <strong>Content type:</strong> ${esc(full.content_type || "n/a")}</p><p class="muted">Redirects</p><pre class="tab-body">${esc(redirects.length ? redirects.map((x) => `${x.status} -> ${x.location} (${x.ms} ms)`).join("\n") : "No redirects followed.")}</pre><p class="muted">Headers</p><pre class="tab-body">${esc(headerText)}</pre><p class="muted">Body</p><pre class="tab-body">${esc(full.body_text || full.error || "Empty body.")}</pre>`;
      } catch (e) { detail.innerHTML = "<p class='muted'>Details could not be loaded.</p>"; }
    }));
  } catch (e) { $("history").innerHTML = "<p class='muted'>History could not be loaded.</p>"; }
}

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
  $("tab-body").textContent = r.body || r.error || "Empty body.";
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

$("mode-inspect").addEventListener("click", () => {
  $("mode-inspect").classList.add("active"); $("mode-webhook").classList.remove("active");
  $("inspect-pane").classList.remove("hidden"); $("webhook-pane").classList.add("hidden");
});
$("mode-webhook").addEventListener("click", () => {
  $("mode-webhook").classList.add("active"); $("mode-inspect").classList.remove("active");
  $("webhook-pane").classList.remove("hidden"); $("inspect-pane").classList.add("hidden");
});

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
  refreshHooks();
});
$("copy-inbox").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("inbox-url").textContent); } catch (e) {} });
$("simulate-hook").addEventListener("click", async () => {
  if (!inboxId) return;
  await fetch(`/api/webhooks/${inboxId}/simulate`, { method: "POST" });
  refreshHooks();
});
$("refresh-hook").addEventListener("click", refreshHooks);

initTheme();
loadHistory();
