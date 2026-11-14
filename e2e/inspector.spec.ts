import { test, expect, request } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "https://http.avenash-kumar.com";
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
const api = () => request.newContext(proxyServer && !baseURL.includes("localhost") ? { proxy: { server: proxyServer } } : {});

async function inspect(ctx: Awaited<ReturnType<typeof api>>, data: Record<string, unknown>) {
  return ctx.post(`${baseURL}/api/inspect`, { data });
}

test.describe("HTTP Inspector", () => {
  test("@api health returns ok", async () => {
    const ctx = await api();
    const res = await ctx.get(`${baseURL}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await ctx.dispose();
  });

  test("@api inspect example.com returns 200 with real timing and headers", async () => {
    const ctx = await api();
    const res = await inspect(ctx, { method: "GET", url: "https://example.com", followRedirects: true, timeoutMs: 10000 });
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data.status).toBe(200);
    expect(data.totalMs).toBeGreaterThan(0);
    expect(data.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(data.headers)).toBe(true);
    expect(data.headers.length).toBeGreaterThan(0);
    expect(data.timing.dnsMs).toBeNull();
    await ctx.dispose();
  });

  test("@api inspect a 404 URL returns 404, and a bad URL is rejected", async () => {
    const ctx = await api();
    const notFound = await inspect(ctx, { method: "GET", url: "https://example.com/this-page-does-not-exist-xyz", followRedirects: true, timeoutMs: 10000 });
    expect(notFound.status()).toBe(200);
    expect((await notFound.json()).status).toBe(404);
    const bad = await inspect(ctx, { method: "GET", url: "not-a-url" });
    expect(bad.status()).toBe(400);
    const local = await inspect(ctx, { method: "GET", url: "http://localhost:3000/" });
    expect(local.status()).toBe(400);
    await ctx.dispose();
  });

  test("@api redirect chain is recorded when following, and stops at the first redirect when not", async () => {
    const ctx = await api();
    const followed = await inspect(ctx, { method: "GET", url: "https://httpbin.org/redirect/3", followRedirects: true, timeoutMs: 15000 });
    expect(followed.status()).toBe(200);
    const followedData = await followed.json();
    expect(followedData.status).toBe(200);
    expect(followedData.redirects.length).toBe(3);
    const stopped = await inspect(ctx, { method: "GET", url: "https://httpbin.org/redirect/3", followRedirects: false, timeoutMs: 15000 });
    expect(stopped.status()).toBe(200);
    const stoppedData = await stopped.json();
    expect(stoppedData.status).toBe(302);
    expect(stoppedData.redirects).toEqual([]);
    await ctx.dispose();
  });

  test("@api POST returns the target's real status, not a canned one", async () => {
    const ctx = await api();
    const res = await inspect(ctx, { method: "POST", url: "https://example.com", followRedirects: true, timeoutMs: 10000 });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe(405);
    await ctx.dispose();
  });

  test("@api inspect with custom headers is accepted", async () => {
    const ctx = await api();
    const res = await inspect(ctx, {
      method: "GET",
      url: "https://example.com",
      headers: [{ name: "X-E2E-Test", value: "playwright" }],
      followRedirects: true,
      timeoutMs: 10000,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe(200);
    await ctx.dispose();
  });

  test("@api-new image inspect returns a media type and no binary body", async () => {
    const ctx = await api();
    const res = await inspect(ctx, { method: "GET", url: "https://picsum.photos/seed/inspector/600/300", followRedirects: true, timeoutMs: 15000 });
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data.status).toBe(200);
    expect(data.mediaType).toBe("image");
    expect(data.body).toBe("");
    expect(data.previewUrl).toContain("picsum.photos");
    await ctx.dispose();
  });

  test("@api webhook inbox create, simulate, and requests round trip", async () => {
    const ctx = await api();
    const created = await ctx.post(`${baseURL}/api/webhooks`, { data: {} });
    expect(created.status()).toBe(201);
    const inbox = await created.json();
    expect(inbox.id).toMatch(/^[0-9a-f]{8}$/);
    expect(inbox.endpoint).toContain(`/hook/${inbox.id}`);
    const empty = await ctx.get(`${baseURL}/api/webhooks/${inbox.id}/requests`);
    expect((await empty.json()).requests).toEqual([]);
    const sim = await ctx.post(`${baseURL}/api/webhooks/${inbox.id}/simulate`, { data: {} });
    expect(sim.status()).toBe(200);
    const after = await ctx.get(`${baseURL}/api/webhooks/${inbox.id}/requests`);
    const requests = (await after.json()).requests;
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].source).toBe("simulate");
    await ctx.dispose();
  });

  test("@api-new webhook metadata returns the inbox and 404s for unknown ids", async () => {
    const ctx = await api();
    const created = await ctx.post(`${baseURL}/api/webhooks`, { data: {} });
    expect(created.status()).toBe(201);
    const inbox = await created.json();
    const meta = await ctx.get(`${baseURL}/api/webhooks/${inbox.id}`);
    expect(meta.status()).toBe(200);
    const metaData = await meta.json();
    expect(metaData.id).toBe(inbox.id);
    expect(metaData.expiresAt).toBeGreaterThan(metaData.createdAt);
    const missing = await ctx.get(`${baseURL}/api/webhooks/00000000`);
    expect(missing.status()).toBe(404);
    await ctx.dispose();
  });

  test("@api webhook simulate and hook post on an unknown inbox return 404", async () => {
    const ctx = await api();
    const sim = await ctx.post(`${baseURL}/api/webhooks/00000000/simulate`, { data: {} });
    expect(sim.status()).toBe(404);
    const hook = await ctx.post(`${baseURL}/hook/00000000`, { data: { hello: "world" } });
    expect(hook.status()).toBe(404);
    await ctx.dispose();
  });

  test("@api a real request to a webhook endpoint is recorded", async () => {
    const ctx = await api();
    const created = await ctx.post(`${baseURL}/api/webhooks`, { data: {} });
    const inbox = await created.json();
    const posted = await ctx.post(`${baseURL}/hook/${inbox.id}?source=test`, {
      data: { event: "ping" },
      headers: { "content-type": "application/json", "x-e2e": "yes" },
    });
    expect(posted.status()).toBe(200);
    const after = await ctx.get(`${baseURL}/api/webhooks/${inbox.id}/requests`);
    const requests = (await after.json()).requests;
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].source).toBe("live");
    expect(requests[0].body_text).toContain("ping");
    await ctx.dispose();
  });

  test("homepage loads with request bar, theme toggle, and favicon", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#url")).toBeVisible();
    await expect(page.locator("#method")).toBeVisible();
    await expect(page.locator("#inspect-btn")).toBeVisible();
    const fav = await page.request.get("/favicon.svg");
    expect(fav.status()).toBe(200);
    expect(fav.headers()["content-type"]).toContain("image/svg+xml");
    await page.locator("#theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#theme-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("theme choice persists across reload", async ({ page }) => {
    await page.goto("/");
    await page.locator("#theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#theme-light").click();
  });

  test("inspect in the UI shows result, waterfall, and history", async ({ page }) => {
    await page.goto("/");
    await page.locator("#url").fill("https://example.com");
    await page.locator("#inspect-btn").click();
    await expect(page.locator("#r-status")).toHaveText("200", { timeout: 20000 });
    await expect(page.locator("#tab-headers")).toBeVisible();
    await page.locator(".tab[data-tab='body']").click();
    await expect(page.locator("#tab-body")).toBeVisible();
    await expect(page.locator("#history")).toContainText("example.com");
  });

  test("try-example fills the URL and inspects it", async ({ page }) => {
    await page.goto("/");
    await page.locator('button[data-url="https://www.avenash-kumar.com"]').click();
    await expect(page.locator("#url")).toHaveValue("https://www.avenash-kumar.com");
    await expect(page.locator("#r-status")).toHaveText("200", { timeout: 20000 });
  });

  test("copy as cURL shows the command", async ({ page }) => {
    await page.goto("/");
    await page.locator("#url").fill("https://example.com");
    await page.locator("#inspect-btn").click();
    await expect(page.locator("#r-status")).toHaveText("200", { timeout: 20000 });
    await page.locator("#copy-curl").click();
    await expect(page.locator("#copy-msg")).toHaveText(/Copied\.|curl -X GET 'https:\/\/example\.com'/);
  });

  test("image URL shows a preview, not binary garbage", async ({ page }) => {
    await page.goto("/");
    await page.locator("#url").fill("https://picsum.photos/seed/inspector/600/300");
    await page.locator("#inspect-btn").click();
    await expect(page.locator("#r-status")).toHaveText("200", { timeout: 20000 });
    await page.locator(".tab[data-tab='body']").click();
    await expect(page.locator("#tab-body img")).toBeVisible();
  });

  test("recent inspections are expandable", async ({ page }) => {
    await page.goto("/");
    await page.locator("#url").fill("https://example.com");
    await page.locator("#inspect-btn").click();
    await expect(page.locator("#r-status")).toHaveText("200", { timeout: 20000 });
    const row = page.locator(".history-item").first();
    await expect(row).toBeVisible();
    await row.locator("summary").click();
    await expect(row.locator(".history-detail")).toContainText("Headers", { timeout: 10000 });
  });

  test("clear history empties the recent inspections", async ({ page }) => {
    await page.goto("/");
    await page.locator("#url").fill("https://example.com");
    await page.locator("#inspect-btn").click();
    await expect(page.locator("#r-status")).toHaveText("200", { timeout: 20000 });
    await expect(page.locator("#history")).toContainText("example.com");
    await page.locator("#clear-history").click();
    await expect(page.locator("#history")).not.toContainText("example.com");
  });

  test("webhook inbox creates, simulates, and shows expandable headers", async ({ page }) => {
    await page.goto("/");
    await page.locator("#mode-webhook").click();
    await page.locator("#create-inbox").click();
    await expect(page.locator("#inbox-url")).toContainText("/hook/");
    await page.locator("#simulate-hook").click();
    const item = page.locator(".hook-item").first();
    await expect(item).toBeVisible();
    await item.locator("summary").click();
    await expect(item).toContainText("Headers");
    await expect(item).toContainText("content-type");
  });

  test("webhook inbox is reopenable after reload and via ?inbox=", async ({ page }) => {
    await page.goto("/");
    await page.locator("#mode-webhook").click();
    await page.locator("#create-inbox").click();
    await expect(page.locator("#inbox-url")).toContainText("/hook/");
    const endpoint = (await page.locator("#inbox-url").textContent()) || "";
    const id = endpoint.split("/hook/")[1].trim();
    expect(id.length).toBeGreaterThan(0);
    await page.locator("#simulate-hook").click();
    await expect(page.locator(".hook-item").first()).toBeVisible();
    await page.reload();
    await page.locator("#mode-webhook").click();
    await expect(page.locator("#inbox-list")).toContainText(id);
    await page.goto(`/?inbox=${id}`);
    await expect(page.locator("#webhook-pane")).toBeVisible();
    await expect(page.locator("#inspect-pane")).toBeHidden();
    await expect(page.locator("#inbox-url")).toContainText(`/hook/${id}`);
    await expect(page.locator(".hook-item").first()).toBeVisible();
    await expect(page.locator(".hook-item").first()).toContainText("POST");
  });

  test("recent inspections hide in webhook mode and show in inspect mode", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#history-section")).toBeVisible();
    await page.locator("#mode-webhook").click();
    await expect(page.locator("#history-section")).toBeHidden();
    await expect(page.locator("#webhook-pane")).toBeVisible();
    await page.locator("#mode-inspect").click();
    await expect(page.locator("#history-section")).toBeVisible();
    await expect(page.locator("#inspect-pane")).toBeVisible();
  });

  test("webhook inbox opens from the Open by ID box", async ({ page }) => {
    await page.goto("/");
    await page.locator("#mode-webhook").click();
    await page.locator("#create-inbox").click();
    await expect(page.locator("#inbox-url")).toContainText("/hook/");
    const endpoint = (await page.locator("#inbox-url").textContent()) || "";
    const id = endpoint.split("/hook/")[1].trim();
    await page.locator("#simulate-hook").click();
    await expect(page.locator(".hook-item").first()).toBeVisible();
    await page.reload();
    await page.locator("#mode-webhook").click();
    await page.locator("#open-inbox-id").fill(id);
    await page.locator("#open-inbox").click();
    await expect(page.locator("#inbox-url")).toContainText(`/hook/${id}`);
    await expect(page.locator(".hook-item").first()).toBeVisible();
    await expect(page.locator(".hook-item").first()).toContainText("POST");
  });
});
