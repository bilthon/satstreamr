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

Obtain a TLS certificate:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --nginx -d satstreamr.example.com
```

Create the site config:

```nginx
# /etc/nginx/sites-available/satstreamr

server {
    listen 80;
    server_name satstreamr.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
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

## Verify

1. Open `https://satstreamr.example.com` in a browser
2. Check the browser console — the signaling WebSocket should connect to `wss://satstreamr.example.com/ws`
3. Deposit sats via Lightning, start a session as tutor, join from another device as viewer
4. Confirm video streams and Cashu micropayments flow correctly

## Environment variables reference

| Variable | Set at | Default | Description |
|---|---|---|---|
| `VITE_MINT_URL` | build time | `{origin}/mint` | Cashu mint URL (override only if not proxied through nginx) |
| `VITE_SIGNALING_URL` | build time | `wss://{host}/ws` | Signaling WebSocket URL (override only if not proxied through nginx) |
| `PORT` | runtime (signaling) | `8080` | Signaling server listen port |
