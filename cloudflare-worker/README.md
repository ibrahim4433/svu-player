# SVU Player — Cloudflare Worker Edge Proxy

This worker proxies catalog requests and `.lrec` lecture downloads between SVU Player and `sessions.svuonline.org`.

## Deployment Instructions

### Method 1: Web Dashboard (Zero Install, 1 Minute)
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Click on your worker: **`svu-proxy`** (or create it if needed).
3. Click **Quick Edit** (or Edit Code).
4. Replace the existing template code with the full contents of [`worker.js`](worker.js).
5. Click **Save and Deploy**.
6. Test in your browser: `https://svu-proxy.iateam.workers.dev/` — it should return:
   ```json
   {
     "status": "ok",
     "service": "SVU Player Edge Proxy",
     "worker": "svu-proxy.iateam.workers.dev",
     "endpoints": ["/api/browse", "/api/download"]
   }
   ```

### Method 2: Via Wrangler CLI
```bash
cd cloudflare-worker
npx wrangler deploy worker.js --name svu-proxy
```
