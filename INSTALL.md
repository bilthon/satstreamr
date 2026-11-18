# Satstreamr — Production Deployment

This guide covers deploying satstreamr on a Linux VPS with nginx serving
the frontend and reverse-proxying the signaling WebSocket server.

## Architecture

```
                        ┌─────────────────────────────┐
                        │          nginx (443)         │
                        │                              │
    browser ──HTTPS───▶ │  /         → static files    │
                        │  /ws       → signaling:8080  │
                        │  /mint     → cashu mint:3338 │
                        └─────────────────────────────┘
```

- **Frontend** — static HTML/JS/CSS built by Vite, served by nginx
- **Signaling server** — Node.js WebSocket server (separate repo: `satstreamr-signaling`)
- **Cashu mint** — Nutshell mint backed by an LND node (can run on the same or a different host)

## Prerequisites

- A Linux server (Ubuntu 22.04+ or Debian 12+ recommended)
- A domain name with DNS pointing to the server (e.g. `satstreamr.example.com`)
- Node.js 20+ and npm
- nginx
- certbot (for Let's Encrypt TLS)
- A running Cashu mint with its URL (e.g. `https://mint.example.com`)

## 1. Build the frontend

Clone the repo and build the static assets. Set `VITE_MINT_URL` and
`VITE_SIGNALING_URL` at build time so the app knows where to reach the
mint and signaling server in production.

```bash
sudo git clone https://github.com/bilthon/satstreamr.git /opt/satstreamr
cd /opt/satstreamr/frontend
npm ci

# Both the mint and signaling server are proxied through nginx,
# so the defaults ({origin}/mint and wss://{host}/ws) work out
# of the box. No VITE_ env vars needed.
npm run build
```

The built files land in `/opt/satstreamr/frontend/dist/`.

## 2. Deploy the signaling server

The signaling server lives in a separate repository.

```bash
sudo git clone https://github.com/bilthon/satstreamr-signaling.git /opt/satstreamr-signaling
cd /opt/satstreamr-signaling/signaling
npm ci
npm run build
```

Run it as a systemd service:

```bash
sudo tee /etc/systemd/system/satstreamr-signaling.service > /dev/null <<'EOF'
[Unit]
Description=Satstreamr Signaling Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/satstreamr-signaling/signaling
ExecStart=/usr/bin/node dist/server.js
Environment=PORT=8080
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now satstreamr-signaling
```

Verify it's listening:

```bash
sudo systemctl status satstreamr-signaling
curl -i --no-buffer \
  --header "Connection: Upgrade" \
  --header "Upgrade: websocket" \
  --header "Sec-WebSocket-Version: 13" \
  --header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8080/
```

## 3. Configure nginx

Obtain a TLS certificate that covers the apex and `www`. The `www` name has to be on the certificate or browsers fail TLS before nginx can redirect it.

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --nginx \
  -d satstreamr.example.com -d www.satstreamr.example.com
```

Create the site config. HTTP and `www` both redirect to the HTTPS apex. Replace `satstreamr.example.com` with the real domain (`satstreamr.com` on the live VPS — see [below](#live-site-satstreamrcom)).

```nginx
# /etc/nginx/sites-available/satstreamr

server {
    listen 80;
    listen [::]:80;
    server_name satstreamr.example.com www.satstreamr.example.com;
    return 301 https://satstreamr.example.com$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.satstreamr.example.com;

    ssl_certificate     /etc/letsencrypt/live/satstreamr.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/satstreamr.example.com/privkey.pem;

    return 301 https://satstreamr.example.com$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name satstreamr.example.com;

    ssl_certificate     /etc/letsencrypt/live/satstreamr.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/satstreamr.example.com/privkey.pem;

    # --- Static frontend ---
    root /opt/satstreamr/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # --- Signaling WebSocket (reverse proxy) ---
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # --- Cashu mint (reverse proxy) ---
    # Proxies mint API calls to the remote mint so the browser treats them
    # as same-origin, avoiding CORS issues.
    location /mint/ {
        proxy_pass https://mint.example.com/;
        proxy_set_header Host mint.example.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_ssl_server_name on;
    }
}
```

Enable the site and reload:

```bash
sudo ln -s /etc/nginx/sites-available/satstreamr /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 4. Updating

To deploy a new version, pull and rebuild on the server:

```bash
# Frontend
cd /opt/satstreamr/frontend
git pull
npm ci
npm run build
# nginx serves the dist/ directory — no reload needed.

# Signaling
cd /opt/satstreamr-signaling/signaling
git pull
npm ci
npm run build
sudo systemctl restart satstreamr-signaling
```

## 5. TURN server (optional but recommended)

WebRTC peer connections may fail behind symmetric NATs without a TURN
relay. Install coturn:

```bash
sudo apt install coturn
```

Generate a shared secret and configure:

```bash
TURN_SECRET=$(openssl rand -hex 32)

sudo tee /etc/turnserver.conf > /dev/null <<EOF
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=satstreamr.example.com
no-tls
no-dtls
EOF

sudo systemctl enable --now coturn
```

The frontend ICE configuration should include this TURN server. Update
the peer connection setup in the frontend source if needed, or pass
the TURN credentials via the signaling server.

## Live site: satstreamr.com

The public site is nginx on the VPS at `45.32.171.155` (`nginx/1.18.0` on Ubuntu). DNS is at Cloudflare (`noel.ns.cloudflare.com`, `raphaela.ns.cloudflare.com`) and the apex is DNS-only: the origin presents its own certificate (`CN=satstreamr.com`, SAN `DNS:satstreamr.com` only). There is no nginx config in this repo to deploy. `www` has to be fixed on Cloudflare and on that VPS.

`www.satstreamr.com` is currently NXDOMAIN, so `https://www.satstreamr.com` never starts a TLS handshake. Adding the DNS record alone is not enough: the certificate does not list `www`, so HTTPS would then fail with a name mismatch until certbot is re-run.

Do not replace the existing `/ws` or `/mint/` locations. Only add the `www` server and point port 80 at the apex.

1. In Cloudflare DNS, add `www` as DNS only (grey cloud), matching the apex. Do not orange-cloud `www` while the apex stays DNS-only — that would terminate TLS at Cloudflare and can break the WebSocket upgrade on `/ws`.

   | Type | Name | Target | Proxy |
   |---|---|---|---|
   | CNAME | `www` | `satstreamr.com` | DNS only |

   An `A` record for `www` pointing at `45.32.171.155` is equivalent. There is no AAAA record today; add one for `www` only if you also add it for the apex.

2. After `www.satstreamr.com` resolves to the VPS, expand the certificate:

   ```bash
   sudo certbot certonly --nginx --expand \
     -d satstreamr.com -d www.satstreamr.com
   ```

3. Add this beside the existing apex `server` block (the one with `server_name satstreamr.com` that serves `/opt/satstreamr/frontend/dist`). Confirm the cert directory with `sudo certbot certificates` if it is not `satstreamr.com`.

   ```nginx
   server {
       listen 80;
       listen [::]:80;
       server_name satstreamr.com www.satstreamr.com;
       return 301 https://satstreamr.com$request_uri;
   }

   server {
       listen 443 ssl http2;
       listen [::]:443 ssl http2;
       server_name www.satstreamr.com;

       ssl_certificate     /etc/letsencrypt/live/satstreamr.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/satstreamr.com/privkey.pem;

       return 301 https://satstreamr.com$request_uri;
   }
   ```

   If port 80 already has a `server` for `satstreamr.com`, add `www.satstreamr.com` to its `server_name` and change the redirect target from `$host` to `satstreamr.com` so HTTP `www` does not bounce to `https://www...`.

4. Test and reload:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   curl -sI https://www.satstreamr.com/ | head
   # expect: HTTP/2 301 and location: https://satstreamr.com/
   ```

5. After the frontend in this commit is built and deployed (`npm run build` into the nginx root), submit the site to Google Search Console:

   - Add a Domain property for `satstreamr.com` (covers apex and `www`) or a URL-prefix property for `https://satstreamr.com/`.
   - Verify with the DNS TXT record Google shows. Add that TXT at Cloudflare.
   - Submit `https://satstreamr.com/sitemap.xml`.
   - Inspect `https://satstreamr.com/` and `https://satstreamr.com/about.html` once the new build is live.

## Verify

1. Open `https://satstreamr.example.com` in a browser
2. Check the browser console — the signaling WebSocket should connect to `wss://satstreamr.example.com/ws`
3. Deposit sats via Lightning, start a session as tutor, join from another device as viewer
4. Confirm video streams and Cashu micropayments flow correctly
5. `curl -sI https://www.satstreamr.example.com/` returns `301` to `https://satstreamr.example.com/`
6. `https://satstreamr.example.com/robots.txt` links to `sitemap.xml`, and that sitemap lists `/` and `/about.html`

## Environment variables reference

| Variable | Set at | Default | Description |
|---|---|---|---|
| `VITE_MINT_URL` | build time | `{origin}/mint` | Cashu mint URL (override only if not proxied through nginx) |
| `VITE_SIGNALING_URL` | build time | `wss://{host}/ws` | Signaling WebSocket URL (override only if not proxied through nginx) |
| `PORT` | runtime (signaling) | `8080` | Signaling server listen port |
