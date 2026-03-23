# satstreamr — Frontend Developer Setup

This guide gets the frontend and signaling server running on your laptop so you
can perform the Gate 2 WebRTC peer-connection test.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | `node --version` to confirm |
| npm | bundled with Node |
| git | to clone repos |
| Chrome or Firefox | WebRTC support required |
| Camera + microphone | or use Chrome's fake-device flag (see below) |

---

## Setup — Signaling Server

The signaling server lives in a separate repository and must be running before
the frontend pages attempt to connect.

```bash
git clone https://github.com/bilthon/satstreamr-signaling
cd satstreamr-signaling/signaling
npm install
npm run build        # compiles TypeScript → dist/
node dist/server.js  # equivalent to: npm start
```

Expected output (JSON log line printed to stdout):

```json
{"timestamp":"...","direction":"outbound","messageType":"server_start","peerId":"server","port":8080}
```

The server listens on `ws://localhost:8080`.

During active development you can skip the build step entirely:

```bash
npm run dev   # runs via ts-node, no compile needed
```

---

## Setup — Frontend

Open a second terminal:

```bash
git clone https://github.com/bilthon/satstreamr
cd satstreamr/frontend
cp .env.example .env   # already configured for localhost
npm install
npm run dev
```

Expected output:

```
  VITE v5.x.x  ready in ...ms
  ➜  Local:   http://localhost:5173/
```

The `.env.example` ships with sensible localhost defaults — no changes needed
for a local Gate 2 test:

```
VITE_SIGNALING_URL=ws://localhost:8080
VITE_MINT_URL=http://localhost:3338
```

---

## Gate 2 Test — WebRTC Peer Connection

Gate 2 verifies that two browser tabs can establish a live WebRTC peer
connection through the signaling server, each with bidirectional audio/video.

### Steps

1. Confirm the signaling server is running and its stdout shows the
   `server_start` log line.

2. Open `http://localhost:5173/tutor.html` in a browser tab.

3. Grant the camera and microphone permission when prompted.

4. The page status line progresses:
   - `connecting...`
   - `connected — creating session…`
   - `session created — waiting for viewer…`

   A session ID (UUID) appears in the blue box below the status, labelled
   **"Share this session ID with your viewer"**. The page also generates a
   ready-made viewer link directly below it.

5. Copy the full viewer link shown on the tutor page, or manually construct:
   ```
   http://localhost:5173/viewer.html?session=<session-id>
   ```

6. Open that URL in a second browser tab (or window).

7. Grant camera and microphone permission on the viewer tab.

8. Open **DevTools (F12) → Console** in both tabs.

9. Watch the status line in both tabs. After ICE negotiation completes you
   will see:
   ```
   ICE connection state: connected
   ```
   in the page status element, and the browser console in both tabs will
   contain:
   ```
   [peer] ICE connection state: connected
   ```

10. Remote video from each peer should appear in the other tab's video element.

### Testing without a real camera

Chrome can inject a synthetic test-pattern video and sine-wave audio so you do
not need a physical webcam or microphone. Launch Chrome with:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream

# Linux
google-chrome \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream
```

With `--use-fake-ui-for-media-stream`, Chrome auto-accepts the permission
prompt so no manual click is required.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Status stays `connecting...` | Signaling server not running | Start `node dist/server.js` on port 8080 |
| `[signaling] error` in console | Wrong `VITE_SIGNALING_URL` | Check `.env` — must be `ws://localhost:8080` |
| Red error box: "No session ID found in URL" | Viewer opened without `?session=` | Use the full viewer link from the tutor page |
| Red error box: `SESSION_NOT_FOUND` | Session ID mismatch or tutor tab closed/reloaded | Reload tutor tab, wait for new session ID, copy fresh link |
| Red error box: `SESSION_FULL` | A second viewer tried to join | The signaling server allows only one viewer per session |
| ICE never reaches `connected` | STUN unreachable or candidates not relaying | Confirm signaling server stdout shows `ice_candidate` log entries; check firewall / VPN |
| Black video / no remote video | `getUserMedia` denied | Check browser permission indicator in address bar or use `--use-fake-device-for-media-stream` |
| "Camera or microphone is already in use" | Another tab or app holds the device | Close other tabs that use the camera, or quit the conflicting app |
| Port 8080 already in use | Another process bound to the port | `lsof -i :8080` (macOS/Linux) to identify and stop it |

---

## Console Log Reference

The following prefixed log lines are emitted by the frontend and are useful for
diagnosing issues:

| Prefix | Meaning |
|---|---|
| `[signaling] connected` | WebSocket connection to the signaling server opened |
| `[signaling] →` | Message sent to the signaling server (with full payload) |
| `[signaling] ←` | Message received from the signaling server (with full payload) |
| `[peer] getUserMedia succeeded` | Camera + microphone access granted |
| `[peer] offer created` | Tutor created the SDP offer |
| `[peer] answer created` | Viewer created the SDP answer |
| `[peer] remote answer set` | Tutor accepted the viewer's answer |
| `[peer] local ICE candidate <type>` | A new local ICE candidate was gathered |
| `[peer] ICE connection state: connected` | Gate 2 pass criterion — both tabs should log this |
| `[peer] ontrack <kind>` | A remote media track (audio or video) was received |
