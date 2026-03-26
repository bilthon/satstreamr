# Unit 17: Session Recording (Chunked Upload)

## Summary
Record the tutor's outgoing media stream using the `MediaRecorder` API, upload 60-second chunks to a minimal Express endpoint, and provide a download link in the session summary. This gives tutors a record of their sessions without requiring any external recording infrastructure.

## Prerequisites
- Unit 06 (WebRTC local media stream available on tutor page)
- Unit 12 (session summary screen where the download link will appear)

## Deliverables
1. Express server at `recording-server/src/server.ts` running on port 3339 with a single endpoint `POST /upload-chunk`:
   - Accepts multipart form data: `sessionId`, `chunkIndex`, `file` (WebM blob).
   - Saves to `recordings/<sessionId>/chunk-<chunkIndex>.webm`.
   - Returns `{ ok: true, path }`.
   - Verification: `curl -F sessionId=test -F chunkIndex=0 -F file=@/tmp/test.webm http://localhost:3339/upload-chunk` saves the file and returns JSON.
2. Express server exposes `GET /recordings/:sessionId` listing all chunks for a session, and `GET /recordings/:sessionId/:filename` for download.
   - Verification: `curl http://localhost:3339/recordings/test` returns a JSON array of filenames after the upload test.
3. Tutor page starts `MediaRecorder` on the local stream when the session enters the active state, with a 60-second `timeslice`.
   - Verification: `MediaRecorder.state === "recording"` in browser DevTools console after session starts.
4. Each `dataavailable` event from `MediaRecorder` triggers a fetch POST to `http://localhost:3339/upload-chunk` with `sessionId` and an incrementing `chunkIndex`.
   - Verification: Recording files appear in `recordings/<sessionId>/` directory while a session is live.
5. Session summary screen shows a "Download Recording" link listing all uploaded chunks.
   - Verification: Clicking a chunk link downloads a valid WebM file playable in VLC.
6. `recording-server/README.md` documents that recordings are NOT seekable without post-processing, and provides the `mkvmerge` command to merge chunks into a seekable file.
   - Verification: File exists with the mkvmerge command.

## Implementation Notes
- `MediaRecorder` codec preference: `video/webm;codecs=vp8,opus` is the most broadly supported in Chrome. Do not promise seekable output — document the `mkvmerge` workflow (Technical Risk #6).
- The `timeslice` parameter to `MediaRecorder.start(60000)` produces blobs at 60-second intervals. Each blob is a valid WebM segment but is not independently seekable from chunk 0.
- Upload failures (network error, server down) must not crash the session. Log the error, show a non-blocking toast "Recording chunk failed to upload", and continue.
- The Express server should serve `recordings/` as a static directory with `express.static` for the download links — no auth needed for MVP (developer-only).
- Chunk file naming must be zero-padded (`chunk-000.webm`, `chunk-001.webm`) so that lexicographic sort matches chronological order for `mkvmerge`.
- Add `recordings/` to `.gitignore`.

## Files to Create/Modify
- `recording-server/src/server.ts` — Express upload and serve server
- `recording-server/package.json` — dependencies: `express`, `multer`; devDependencies: `typescript`, `@types/express`, `@types/multer`
- `recording-server/tsconfig.json`
- `recording-server/start.sh` — startup script
- `recording-server/README.md` — mkvmerge documentation
- `frontend/src/lib/recorder.ts` — MediaRecorder wrapper with chunk upload logic
- `frontend/src/pages/tutor.ts` — start recorder on session active
- `.gitignore` — add `recordings/`

## Estimated Effort
5–7 hours
