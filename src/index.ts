export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
}

const MAX_BODY = 200 * 1024;
const MAX_REDIRECTS = 5;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

function mediaTypeFor(contentType: string | null): "image" | "audio" | "video" | "pdf" | "binary" | "text" {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct.includes("application/pdf")) return "pdf";
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript") || ct.includes("application/x-www-form-urlencoded")) return "text";
  if (!ct) return "text";
  return "binary";
}

function headersToArray(h: Headers): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  h.forEach((value, name) => out.push({ name, value }));
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true });

    if (path.startsWith("/demo/")) return handleDemo(request, url);

    if (path.startsWith("/hook/")) {
      const id = path.slice(6).split("/")[0];
      return handleHook(request, env, id);
    }

    if (path.startsWith("/api/")) return handleApi(request, env, url);

    if (path === "/" || path === "/index.html") return env.ASSETS.fetch(request);
    return env.ASSETS.fetch(request);
  },
};

async function handleDemo(request: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const name = parts[1] || "";

  if (name === "200") {
    return json({ demo: "ok", status: 200, message: "This is a demo 200 response from the HTTP Inspector itself." });
  }
  if (name === "404") {
    return json({ demo: "not-found", status: 404, message: "This is a demo 404 response from the HTTP Inspector itself." }, 404);
  }
  if (name === "headers") {
    return json({ demo: "headers", method: request.method, url: url.toString(), headers: headersToArray(request.headers) });
  }
  if (name === "slow") {
    const ms = Math.min(5000, Math.max(100, Number(url.searchParams.get("ms") || "2000")));
    await new Promise((r) => setTimeout(r, ms));
    return json({ demo: "slow", waitedMs: ms, message: `Waited ${ms} ms before responding.` });
  }
  if (name === "image") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#0B1526"/><rect x="40" y="40" width="520" height="220" rx="16" fill="#4F46E5"/><text x="300" y="165" font-family="sans-serif" font-size="42" font-weight="bold" fill="#ffffff" text-anchor="middle">HTTP Inspector demo</text></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
  }
  if (name === "redirect") {
    const n = Math.min(5, Math.max(0, Number(parts[2] || "0")));
    if (n <= 0) return json({ demo: "redirect", status: 200, message: "End of the demo redirect chain." });
    return new Response(null, { status: 302, headers: { location: `/demo/redirect/${n - 1}` } });
  }
  return json({ error: "Unknown demo. Try /demo/200, /demo/redirect/3, /demo/404, /demo/headers, /demo/slow, or /demo/image." }, 404);
}

async function fetchTarget(target: URL, env: Env, init: RequestInit): Promise<Response> {
  let ownHost = "";
  try { ownHost = new URL(env.BASE_URL).hostname; } catch { ownHost = ""; }
  if (ownHost && target.hostname === ownHost && target.pathname.startsWith("/demo/")) {
    return handleDemo(new Request(target.toString(), { method: init.method || "GET", headers: init.headers }), target);
  }
  return fetch(target.toString(), init);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[1] === "inspect" && request.method === "POST") {
    const body = await request.json().catch(() => null) as any;
    if (!body || typeof body.url !== "string") return json({ error: "url is required" }, 400);
    let target: URL;
    try {
      target = new URL(body.url);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("bad protocol");
    } catch {
      return json({ error: "Enter a valid http or https URL" }, 400);
    }
    if (isPrivateHost(target.hostname)) return json({ error: "Private and local addresses are blocked" }, 400);

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) {
      return json({ error: "Unsupported method" }, 400);
    }
    const followRedirects = body.followRedirects !== false;
    const timeoutMs = Math.min(30000, Math.max(1000, Number(body.timeoutMs || 10000)));
    const customHeaders: Record<string, string> = {};
    if (Array.isArray(body.headers)) {
      for (const h of body.headers) {
        if (h && typeof h.name === "string" && typeof h.value === "string") customHeaders[h.name] = h.value;
      }
    }

    const id = crypto.randomUUID();
    const started = Date.now();
    const redirects: { status: number; location: string; ms: number }[] = [];
    let current = target;
    let response: Response | null = null;
    let error: string | null = null;
    let ttfbMs: number | null = null;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        response = await fetchTarget(current, env, {
          method,
          headers: { ...customHeaders, "user-agent": "http-inspector/0.1 (+https://http.avenash-kumar.com)" },
          body: method === "GET" || method === "HEAD" ? undefined : (typeof body.body === "string" ? body.body : undefined),
          redirect: "manual",
          signal: controller.signal,
        });
        ttfbMs = Date.now() - t0;
      } catch (e: any) {
        error = e?.name === "AbortError" ? `Request timed out after ${timeoutMs} ms` : `Fetch failed: ${e?.message || "unknown error"}`;
        clearTimeout(timer);
        break;
      }
      clearTimeout(timer);
      if (!response) break;
      if (followRedirects && [301, 302, 303, 307, 308].includes(response.status)) {
        const loc = response.headers.get("location");
        if (!loc) break;
        redirects.push({ status: response.status, location: loc, ms: Date.now() - t0 });
        if (i === MAX_REDIRECTS) break;
        try {
          current = new URL(loc, current);
        } catch {
          break;
        }
        if (response.status === 303) {
          // Per HTTP, a 303 turns the follow up into a GET. Keep it simple and continue with GET.
        }
        continue;
      }
      break;
    }

    const totalMs = Date.now() - started;
    if (!response) {
      const row = { id, method, url: target.toString(), status: null, statusText: null, createdAt: started, totalMs, ttfbMs, sizeBytes: 0, contentType: null, mediaType: "text" as const, previewUrl: target.toString(), headers: [], body: "", redirects, error };
      return json({ ...row, timing: { totalMs, ttfbMs, downloadMs: 0, dnsMs: null, tcpMs: null, tlsMs: null, note: "Workers fetch does not expose DNS, TCP, or TLS timing, so those are shown as not available, not simulated." }, tls: { available: false, note: "Workers fetch does not expose the TLS version or cipher for the outgoing connection." } });
    }

    const buf = await response.arrayBuffer();
    const headers = headersToArray(response.headers);
    const contentType = response.headers.get("content-type");
    const mediaType = mediaTypeFor(contentType);
    const cookies = headers.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
    const downloadMs = Math.max(0, totalMs - (ttfbMs || 0));
    // Binary bodies (images, audio, video, PDFs, archives) are never decoded
    // to text, so the UI never shows garbled bytes. The frontend renders a
    // preview from the original URL instead. History is stored in the
    // visitor's browser localStorage, not in D1, so nothing is inserted here.
    let bodyText = "";
    let truncated = false;
    if (mediaType === "text") {
      const text = new TextDecoder().decode(buf);
      truncated = text.length > MAX_BODY;
      bodyText = truncated ? text.slice(0, MAX_BODY) : text;
    }

    return json({
      id, method, url: target.toString(), status: response.status, statusText: response.statusText,
      createdAt: started, totalMs, ttfbMs, sizeBytes: buf.byteLength,
      contentType, mediaType, previewUrl: target.toString(), headers, body: bodyText, truncated, redirects, cookies,
      timing: { totalMs, ttfbMs, downloadMs, dnsMs: null, tcpMs: null, tlsMs: null, note: "Workers fetch does not expose DNS, TCP, or TLS timing, so those are shown as not available, not simulated." },
      tls: { available: false, note: "Workers fetch does not expose the TLS version or cipher for the outgoing connection." },
      verdict: response.status >= 200 && response.status < 300 ? "OK. The URL responded successfully." : response.status >= 300 && response.status < 400 ? "Redirect. Follow the location header to reach the final URL." : response.status >= 400 && response.status < 500 ? "Client error. Check the URL, method, headers, and auth." : "Server error. The target server returned an error status.",
    });
  }

  // Inspection history is stored in the visitor's browser localStorage, not
  // in D1. D1 is only used for webhook inboxes, which must receive requests
  // from other servers while the visitor's browser is closed.

  if (parts[1] === "webhooks" && parts.length === 2 && request.method === "POST") {
    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO webhooks (id, created_at, expires_at) VALUES (?, ?, ?)").bind(id, now, now + 24 * 60 * 60 * 1000).run();
    const base = env.BASE_URL.replace(/\/$/, "");
    return json({ id, endpoint: `${base}/hook/${id}`, expiresAt: now + 24 * 60 * 60 * 1000 }, 201);
  }

  if (parts[1] === "webhooks" && parts.length === 3 && request.method === "GET") {
    const hook = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(parts[2]).first();
    if (!hook) return json({ error: "Webhook inbox not found" }, 404);
    return json({ id: hook.id as string, createdAt: hook.created_at as number, expiresAt: hook.expires_at as number });
  }

  if (parts[1] === "webhooks" && parts.length === 4 && parts[3] === "requests" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM webhook_requests WHERE webhook_id = ? ORDER BY received_at DESC LIMIT 100").bind(parts[2]).all();
    return json({ requests: rows.results || [] });
  }

  if (parts[1] === "webhooks" && parts.length === 4 && parts[3] === "simulate" && request.method === "POST") {
    const webhookId = parts[2];
    const hook = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(webhookId).first();
    if (!hook) return json({ error: "Webhook inbox not found" }, 404);
    const sample = JSON.stringify({ event: "test", message: "Hello from HTTP Inspector", at: new Date().toISOString() }, null, 2);
    await env.DB.prepare(
      "INSERT INTO webhook_requests (id, webhook_id, method, path, query, headers_json, body_text, received_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), webhookId, "POST", `/hook/${webhookId}`, "", JSON.stringify([{ name: "content-type", value: "application/json" }]), sample, Date.now(), "simulate").run();
    return json({ ok: true, message: "Simulated webhook request recorded." });
  }

  return json({ error: "Not found" }, 404);
}

async function handleHook(request: Request, env: Env, id: string): Promise<Response> {
  const hook = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first();
  if (!hook) return json({ error: "Webhook inbox not found" }, 404);
  const url = new URL(request.url);
  const text = await request.text().catch(() => "");
  await env.DB.prepare(
    "INSERT INTO webhook_requests (id, webhook_id, method, path, query, headers_json, body_text, received_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), id, request.method, url.pathname, url.search, JSON.stringify(headersToArray(request.headers)), text.slice(0, MAX_BODY), Date.now(), "live").run();
  return json({ ok: true, received: true, webhookId: id });
}
