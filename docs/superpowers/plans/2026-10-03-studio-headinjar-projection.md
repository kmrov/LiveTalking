# Studio → Head in Jar Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a conversation in Studio drive the avatar session sent to Head in Jar over WHIP.

**Architecture:** LiveTalking creates a WHIP avatar session with the selected avatar, voice reference, and Batya conversation ID. Studio treats that session as its active conversation target while projection is connected; its local WebRTC preview remains a separate, optional target. ASR continues to return text to the renderer, which sends it to the active target.

**Tech Stack:** Python aiohttp/aiortc, Electron renderer JavaScript, Node test runner, Python unittest.

**Spec:** `docs/superpowers/specs/2026-09-28-livetalking-desktop-design.md` (Connections screen and outgoing WHIP).

## Global Constraints

- Preserve existing Studio profiles, avatar/model files, user edits, and Batya database.
- WHIP token is held only in UI memory and omitted from status/logs/profile.
- Head in Jar owns projector output and manual physical calibration.
- No automatic projector start; operator starts projection explicitly.

## Review Focus

- WHIP disconnect or remote failure must clear the active target and disable commands.
- A Batya conversation must retain its ID when switching between preview and projection.
- Stop and profile/avatar changes must disconnect only the Studio-owned WHIP session.
- A failed WHIP handshake must leave no leaked avatar session.
- A delayed answer after target switch must not speak into the new session.

---

### Task 1: Parameterized WHIP avatar session

**Files:** `server/rtc_manager.py`, `server/routes.py`, `tests/test_whip_push.py`, `tests/test_whip_routes.py`

**Interfaces:** `connect_whip(url, token, sessionid="0", params=None)` creates a session using `avatar`, `refaudio`, `reftext`, `batya_conversation_id`; status returns `sessionid` only when connected. Existing callers remain valid.

- [x] Add a failing test that POST `/api/whip/connect` forwards the four session parameters and exposes the session ID without the token.
- [x] Run focused Python WHIP tests and confirm the new test fails for missing parameters.
- [x] Implement parameter validation, forwarding, and cleanup while preserving old clients.
- [x] Run focused Python WHIP tests and confirm all pass.

### Task 2: Projection client and active conversation target

**Files:** `desktop/renderer/projection-client.mjs`, `desktop/test/projection-client.test.mjs`, `desktop/renderer/studio.mjs`, `desktop/test/conversation-client.test.mjs`

**Interfaces:** Projection client `connect({url,token,avatarId,referenceWav,referenceText,conversationId})`, `disconnect()`, `status()`, `sessionId()`; Studio targets `projection.sessionId()` while connected and preview session otherwise.

- [x] Add failing tests for connection/status, error cleanup, and switching conversation target.
- [x] Run focused Node tests and confirm expected failure.
- [x] Implement client, target selection, SSE rebinding, and command gating.
- [x] Run focused Node tests and confirm pass.

### Task 3: Studio controls, lifecycle, and documentation

**Files:** `desktop/renderer/studio.html`, `desktop/renderer/studio.css`, `desktop/renderer/studio.mjs`, `desktop/scripts/smoke-electron.mjs`, `desktop/README.md`

**Interfaces:** UI accepts Head in Jar WHIP URL and bearer token and shows connect/disconnect/state. It disconnects on Stop, avatar change, conversation change, and window close; the operator starts projection in Head in Jar.

- [x] Add smoke coverage for projection connect, directed chat, interruption, disconnect, and error/retry using a fixture receiver.
- [x] Run smoke and confirm the new assertions fail.
- [x] Add controls and lifecycle wiring; document setup and operator steps.
- [x] Run desktop tests/build/smoke and Python WHIP tests; inspect results.

### Task 4: End-to-end verification

**Files:** `docs/superpowers/reviews/2026-10-03-studio-headinjar-projection.md`

- [ ] Run the actual Studio and Head in Jar apps with the configured model, Qwen, and Batya when hardware access allows.
- [ ] Verify projected audio/video, microphone → ASR → Batya → TTS, interrupt, reconnect, and history; record any unavailable physical checks plainly.
- [x] Check `git diff` for unrelated edits and secrets, then record evidence and remaining limits.
