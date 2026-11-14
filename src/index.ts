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

    if (path.startsWith("/hook/")) {
      const id = path.slice(6).split("/")[0];
      return handleHook(request, env, id);
    }

    if (path.startsWith("/api/")) return handleApi(request, env, url);

    if (path === "/" || path === "/index.html") return env.ASSETS.fetch(request);
    return env.ASSETS.fetch(request);
  },
};

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
        response = await fetch(current.toString(), {
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
      const row = { id, method, url: target.toString(), status: null, statusText: null, createdAt: started, totalMs, ttfbMs, sizeBytes: 0, contentType: null, headers: [], body: "", redirects, error };
      await env.DB.prepare(
        "INSERT INTO inspections (id, method, url, status, status_text, created_at, total_ms, ttfb_ms, size_bytes, content_type, headers_json, body_text, redirects_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, method, target.toString(), null, null, started, totalMs, ttfbMs, 0, null, "[]", "", JSON.stringify(redirects), error).run();
      return json({ ...row, timing: { totalMs, ttfbMs, downloadMs: 0, dnsMs: null, tcpMs: null, tlsMs: null, note: "Workers fetch does not expose DNS, TCP, or TLS timing, so those are shown as not available, not simulated." }, tls: { available: false, note: "Workers fetch does not expose the TLS version or cipher for the outgoing connection." } });
    }

    const text = await response.text();
    const truncated = text.length > MAX_BODY;
    const bodyText = truncated ? text.slice(0, MAX_BODY) : text;
    const downloadMs = Math.max(0, totalMs - (ttfbMs || 0));
    const headers = headersToArray(response.headers);
    const contentType = response.headers.get("content-type");
    const cookies = headers.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);

    await env.DB.prepare(
      "INSERT INTO inspections (id, method, url, status, status_text, created_at, total_ms, ttfb_ms, size_bytes, content_type, headers_json, body_text, redirects_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, method, target.toString(), response.status, response.statusText, started, totalMs, ttfbMs, new TextEncoder().encode(text).length, contentType, JSON.stringify(headers), bodyText, JSON.stringify(redirects), null).run();

    return json({
      id, method, url: target.toString(), status: response.status, statusText: response.statusText,
      createdAt: started, totalMs, ttfbMs, sizeBytes: new TextEncoder().encode(text).length,
      contentType, headers, body: bodyText, truncated, redirects, cookies,
      timing: { totalMs, ttfbMs, downloadMs, dnsMs: null, tcpMs: null, tlsMs: null, note: "Workers fetch does not expose DNS, TCP, or TLS timing, so those are shown as not available, not simulated." },
      tls: { available: false, note: "Workers fetch does not expose the TLS version or cipher for the outgoing connection." },
      verdict: response.status >= 200 && response.status < 300 ? "OK. The URL responded successfully." : response.status >= 300 && response.status < 400 ? "Redirect. Follow the location header to reach the final URL." : response.status >= 400 && response.status < 500 ? "Client error. Check the URL, method, headers, and auth." : "Server error. The target server returned an error status.",
    });
  }

  if (parts[1] === "history" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, method, url, status, status_text, created_at, total_ms FROM inspections ORDER BY created_at DESC LIMIT 50").all();
    return json({ inspections: rows.results || [] });
  }

  if (parts[1] === "inspect" && request.method === "GET" && parts.length === 3) {
    const row = await env.DB.prepare("SELECT * FROM inspections WHERE id = ?").bind(parts[2]).first();
    if (!row) return json({ error: "Inspection not found" }, 404);
    return json(row);
  }

  if (parts[1] === "webhooks" && request.method === "POST") {
    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO webhooks (id, created_at, expires_at) VALUES (?, ?, ?)").bind(id, now, now + 24 * 60 * 60 * 1000).run();
    const base = env.BASE_URL.replace(/\/$/, "");
    return json({ id, endpoint: `${base}/hook/${id}`, expiresAt: now + 24 * 60 * 60 * 1000 }, 201);
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
