# HTTP Inspector

Check status, headers, timing, and redirects for any URL, from the server side, so CORS does not block you. Includes a temporary webhook inbox. Runs on Cloudflare Workers and D1. Live at https://http.avenash-kumar.com

## Features

- Inspect any http or https URL with GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS
- Real status, headers, body, size, total time, and time to first byte, measured by the Worker
- Redirect chain, up to 5 redirects, with status and location for each hop
- Cookies from set-cookie headers, and copy as cURL
- Recent inspection history, stored only in the visitor's browser localStorage (last 50)
- Webhook inbox with a temporary endpoint, live capture, and a simulate button
- Built-in demo pages for the try-examples, hosted by the Worker itself so they never depend on a third party site: /demo/200, /demo/redirect/3, /demo/404, /demo/headers, /demo/slow?ms=2000, /demo/image
- Light and dark mode, with a toggle that remembers your choice

## Honest limits

Workers fetch does not expose DNS, TCP, or TLS timing, or the TLS version and cipher for the outgoing connection. This app reports total time, time to first byte, and download time, and shows DNS, TCP, and TLS as not available. It does not invent those numbers. The prototype used simulated timings. The real app uses real timings only.

Private and local addresses are blocked, to avoid server side request forgery.

## Tech

- Cloudflare Workers, TypeScript, and D1
- Static frontend in `public/`, no build step for the UI
- GitHub Actions plus Wrangler for deploy on merge to main

## Local setup

```bash
npm install
npx wrangler d1 create http-inspector
# Copy the database_id from the output into wrangler.toml
npx wrangler d1 migrations apply http-inspector --local
npm run dev
```

Open http://localhost:8787

## Deploy

1. Create the D1 database once, in production:
```bash
npx wrangler d1 migrations apply http-inspector --remote
```
2. In Cloudflare, add the custom domain `http.avenash-kumar.com` to the Worker, or use the route in `wrangler.toml`.
3. In GitHub, add these repo secrets:
   - `CLOUDFLARE_API_TOKEN`, a token with Edit Cloudflare Workers permission for this account
   - `CLOUDFLARE_ACCOUNT_ID`, from the Cloudflare dashboard
4. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs migrations, then `wrangler deploy`.

Do not paste tokens or account IDs in chat. Add them only in GitHub Secrets.

## API

- `POST /api/inspect` with `{ method, url, headers, body, followRedirects, timeoutMs }`. The response includes `mediaType` (`text`, `image`, `audio`, `video`, `pdf`, or `binary`) and `previewUrl`. Binary bodies are never returned as text, so image, audio, video, and PDF results render as a preview in the UI instead of garbled bytes.
- Inspection history is stored in the visitor's browser localStorage (last 50), not in D1. D1 is only used for webhook inboxes, which must receive requests from other servers while the visitor's browser is closed.
- `POST /api/webhooks`, creates an inbox and returns its endpoint
- `GET /api/webhooks/:id`, returns the inbox with its created and expiry times, or 404
- `GET /api/webhooks/:id/requests`
- `POST /api/webhooks/:id/simulate`
- `POST /hook/:id`, any method, records the request and returns 200
- Webhook inboxes are reopenable: every inbox created in the browser is saved in localStorage under `http-inspector-inboxes` (last 20) and shown in a My inboxes list, and any inbox can be reopened from a link like `/?inbox=<id>` or by pasting its ID or endpoint into the Open inbox box. Messages live on the server for 24 hours.

## Design

The UI uses an improvised palette inspired by a clean premium style, not a copy of any other brand. Hero: deep midnight #0B1526 to indigo #3730A3. Primary: electric indigo #4F46E5. Accent: teal #2DD4BF. Headings: ink #0F172A. Font: Manrope. Light and dark mode are both included.

## E2E tests

Playwright tests in `e2e/` run against the live site by default (`https://http.avenash-kumar.com`, override with `E2E_BASE_URL`):

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

They cover health, homepage and theme toggle, a real inspect of example.com, a 404 inspect, rejected and private URLs, the UI result and history, expandable history rows, an image preview instead of binary text, and the webhook inbox with expandable headers. The `E2E tests` workflow in `.github/workflows/e2e.yml` runs them on every push to main and on pull requests.
