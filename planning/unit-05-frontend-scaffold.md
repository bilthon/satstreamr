# Unit 05: Frontend Scaffold (TypeScript + Vite)

## Status

**Complete** — 2026-03-22

- Multi-page Vite 5 project scaffolded at `frontend/` with TypeScript strict mode
- `tutor.html` and `viewer.html` with `#status` indicators
- `SignalingClient` WebSocket wrapper with typed messages, `onConnect`/`onDisconnect` callbacks
- Signaling message types mirrored from server in `src/types/signaling.ts`
- Environment config: `VITE_SIGNALING_URL`, `VITE_MINT_URL`
- `npm run build` exits 0 with zero TypeScript errors

## Summary
Initialize the browser application with Vite and TypeScript, create the two-page structure (tutor page and viewer page), and wire up a basic WebSocket connection to the signaling server. No media or payment logic yet — this unit delivers the shell that all subsequent browser units build into.

## Prerequisites
- Unit 04 (signaling server running on port 8080)
- Node.js 18+ and npm

## Deliverables
1. Vite project at `frontend/` scaffolded with TypeScript template, no framework.
   - Verification: `npm run dev` in `frontend/` starts the dev server on port 5173 without errors.
2. Two HTML entry points: `frontend/tutor.html` and `frontend/viewer.html`, each with a visible heading ("Tutor" / "Viewer") and a connection status indicator.
   - Verification: Navigating to `http://localhost:5173/tutor.html` and `/viewer.html` shows the correct heading.
3. `frontend/src/signaling-client.ts` — a typed WebSocket wrapper that:
   - Connects to `ws://localhost:8080`.
   - Exposes `send(msg: SignalingMessage): void` and `onMessage(handler): void`.
   - Logs every sent/received message to the browser console.
   - Verification: Opening tutor page shows `[signaling] connected` in the browser console.
4. `frontend/.env` (gitignored) and `frontend/.env.example` with `VITE_SIGNALING_URL=ws://localhost:8080` and `VITE_MINT_URL=http://localhost:3338`.
   - Verification: `import.meta.env.VITE_SIGNALING_URL` resolves correctly in browser.
5. Shared TypeScript types for signaling messages in `frontend/src/types/signaling.ts` that mirror the server-side types from Unit 04.
   - Verification: `npm run build` completes with zero TypeScript errors.

## Implementation Notes
- Use `vite` with `@vitejs/plugin-legacy` only if Safari support is needed — skip for MVP (Safari is warned/blocked in Unit 10).
- The Vite multi-page setup requires listing both HTML files in `vite.config.ts` under `build.rollupOptions.input`.
- `VITE_MINT_URL` must be hardcoded to `http://localhost:3338` in `.env.example` — no runtime chooser (Technical Risk #5).
- Keep the signaling client reconnect logic minimal in this unit; full WS reconnect with backoff is Unit 09.
- Structure `frontend/src/` with subdirectories: `types/`, `lib/`, `pages/` — enforce this layout from the start to avoid refactoring later.

## Files to Create/Modify
- `frontend/index.html` — redirect or landing (optional)
- `frontend/tutor.html` — tutor entry point
- `frontend/viewer.html` — viewer entry point
- `frontend/src/pages/tutor.ts` — tutor page logic
- `frontend/src/pages/viewer.ts` — viewer page logic
- `frontend/src/signaling-client.ts` — WebSocket wrapper
- `frontend/src/types/signaling.ts` — shared message types
- `frontend/vite.config.ts` — multi-page Vite config
- `frontend/tsconfig.json` — TypeScript config
- `frontend/package.json` — dependencies: `vite`, `typescript`
- `frontend/.env.example` — environment variable template
- `frontend/.gitignore` — excludes `.env`, `dist/`

## Estimated Effort
3–5 hours
