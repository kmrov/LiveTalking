# LiveTalking Desktop Batya Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, task by task. Steps use checkbox syntax for tracking.

**Goal:** Start/adopt Batya from Studio, resume persistent conversations, and speak streamed Batya answers through all LiveTalking chat clients.

**Architecture:** Batya remains a separate FastAPI/PostgreSQL service. Its opt-in speech stream resolves tools before streaming a final answer. LiveTalking owns ordered turns, phrase buffering, retries and speech interruption; Electron owns configuration, secrets, process lifecycle and persistent conversation selection.

**Tech Stack:** Python 3.13 Batya/FastAPI/LangGraph; existing LiveTalking Python/aiohttp; Electron 44/ES modules; Linux Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-28-livetalking-desktop-design.md`, including the user revision requiring streaming speech before `done`.

## Global Constraints

- Linux first; Python environments, CUDA and models remain separate installations.
- All `/human` chat uses the selected Batya brain; echo continues direct TTS.
- Persist conversation IDs; same ID survives WebRTC reconnect and application restart.
- API/database credentials travel only in child environment; keyring persistence or session memory, never profile JSON or argv/logs.
- Stop/quit affects only owned processes/containers and preserves the database volume.
- Preserve unrelated dirty files in both repositories, including Batya persona.
- No automatic dependency installation, model download, document upload or book indexing.

## Review Focus

1. Tool-bearing preliminary prose must never be spoken; speech must start before upstream `done`.
2. Retried requests, shared conversations and interrupts must preserve order without duplicated speech/history.
3. Stop during DB/API startup and repeated Stop must leave no owned processes; adopted DB/API stay running.
4. Existing profiles and external clients without conversation IDs must remain usable.
5. Missing credentials, incompatible running services and streaming failures must be actionable and redact credentials.

---

### Task 1: Batya speech-stream protocol

**Files:** Modify `~/batya/src/batya/{schemas,api,graph}.py`; test `~/batya/tests/{test_graph,test_api}.py`.

**Interfaces:** Produces POST messages `speech_stream: true`, streamed `delta`/`done` with no provisional reset; `/api/v1/capabilities` advertises `speech_stream: 1`. Existing endpoints and normal streaming retain their behavior.

- [x] Write tests proving memory-tool planning is silent, the first final delta arrives while the turn is pending, final text persists, and the request flag reaches the graph.
- [x] Run tests in a temporary copy; expect unsupported flag/signature or wrong deltas.
- [x] Add optional mode to schema/graph and capability endpoint. Resolve tools silently before a tools-disabled final stream; cap tool rounds and close generators on cancellation.
- [x] Run Batya tests without DB; expect all pass. Apply only those changes to the actual Batya checkout and verify there too.
- [x] Commit Batya integration files on its own feature branch; leave persona untouched.

### Task 2: Ordered streaming brain adapter

**Files:** Create `server/batya_brain.py`, `tests/test_batya_brain.py`; modify `config.py`, `server/routes.py`, `server/session_manager.py`, `server/rtc_manager.py`, `avatars/base_avatar.py`.

**Interfaces:** `BatyaBrain(base_url, transport=None).submit(avatar, text, request_id=None)` returns `{conversation_id, request_id}`; `.close()` finishes/cancels background work. `speech_stream` request consumes Task 1. Avatar emits JSON events `{brain:'batya', event, conversation_id, request_id, ...}` through `/sse`. WebRTC accepts `batya_conversation_id`; session status exposes it and pending state.

- [x] Write adapter tests for speech before done, final fragment once, interrupted old turn suppression, shared-conversation order, identical request retry, duplicate conflict, missing done and reset/error handling.
- [x] Run focused tests; expect missing adapter.
- [x] Implement aiohttp SSE parsing, phrase buffering (punctuation or bounded word boundary), conversation creation, serial task chaining, stable IDs and bounded deduplication. Retry interrupted transport with the same ID, suppressing delivered prefixes; fail on divergent replay.
- [x] Route all Batya chat through the adapter, validate text/IDs before interruption; retain echo/direct behavior. Propagate offer conversation ID, expose per-session brain status, register cleanup. Adopt only required existing generation/ASR-registration hunks for clean-checkout correctness.
- [x] Run Python suite; expect all pass. Commit adapter and scoped changes.

### Task 3: Brain profiles, secrets and API bridge

**Files:** Modify `desktop/src/profile.mjs`, `desktop/electron/{main,preload}.mjs` (preload is `.cjs`); create `desktop/electron/batya-api.mjs`, `desktop/electron/service-environment.mjs`; tests in `desktop/test/`.

**Interfaces:** Profile `brain:{mode:'direct'|'batya', root, python, url, managed, databaseMode:'compose'|'external', folderId, conversationId}`; normalized missing brain defaults to direct. Named trusted IPC for list/create/history/memories/document input and secret set/status. Keys/database URL never returned to renderer.

- [x] Write tests for profile migration, invalid UUID/URL/path, narrow API operations and secret exclusion; run and observe failure.
- [x] Add validation, discover `~/batya` or adjacent checkout and Python, load known env files without shell evaluation, redact known secrets in diagnostics.
- [x] Implement bounded main-process Batya API operations and safeStorage-backed secret settings; persist selected conversation ID independently of session.
- [x] Run desktop tests; expect pass. Commit profile/bridge changes.

### Task 4: Managed Batya/database lifecycle

**Files:** Create `desktop/electron/batya-supervisor.mjs`, `desktop/electron/batya-prerequisites.mjs`; modify `desktop/electron/{main,supervisor}.mjs`; tests in `desktop/test/`.

**Interfaces:** Batya supervisor `.start(profile, environment)`, `.stop()`, `.snapshot()` reports `batya` and `database` stages, ownership and safe logs. Task 3 supplies environment/profile. LiveTalking argv selects `--llm_provider batya --batya_url URL`; compatible health includes active brain provider.

- [x] Write ownership tests for existing API adoption, DB adoption, owned DB/API cleanup, Stop during startup and duplicate Start/Stop; run to RED.
- [x] Check Python 3.13/modules, compose/DB config and required credential presence or ready compatible API. Start only `db`, never delete volumes; spawn uvicorn on loopback via argv/env; monitor health/capability and stop owned resources in reverse order.
- [x] Integrate start/stop/quit and failure recovery with existing lifecycle; reject an existing LiveTalking whose brain mode/URL differs from the profile.
- [x] Run desktop tests; expect pass. Commit lifecycle changes.

### Task 5: Studio brain controls and persistent history

**Files:** Modify `desktop/renderer/{studio.mjs,studio.html,studio.css,webrtc-client.mjs,conversation-client.mjs}`; create `desktop/renderer/brain-events.mjs`; tests in `desktop/test/`.

**Interfaces:** Consumes Tasks 2–4. Select/create conversations through trusted bridge before connecting; offer sends persistent ID. SSE provisional rows track request ID; done reconciles authoritative text. On interrupt display that brain is finishing; queued turn remains ordered.

- [x] Write tests for offer ID propagation, SSE reducer delta/reset/done/error behavior and stale conversation events; run to RED.
- [x] Add brain/service settings, credential inputs with persistence status, conversations/history, memory viewer and explicit text-document upload. Display streamed assistant responses and brain states; clear event connections on disconnect and reload persisted history.
- [x] Add stable request IDs to chat commands; preserve IDs on explicit network retry. Save the selected conversation before reconnect; mark restart-only brain changes.
- [x] Run desktop tests/build; expect pass. Commit UI changes.

### Task 6: Integrated verification and operator guidance

**Files:** Modify `desktop/scripts/{fixture-server,smoke-electron}.mjs`, `desktop/README.md`; add integration fixture/test as needed.

**Interfaces:** All prior tasks; test-only fixture supplies capability, persistent conversation/history and held-open speech stream.

- [x] Add Electron smoke case: select Batya→create conversation→connect→chat→streamed assistant→interrupt→reconnect→same history/ID→Stop; test failure and direct-mode recovery.
- [x] Run complete Batya/Python/desktop suites and build/smoke; expect pass.
- [ ] Verify actual existing PostgreSQL/Batya/API and local avatar flow; measure first TTS phrase before done, verify stored history, reconnect and app restart. Use only synthetic verification conversations/documents.
- [x] Document setup, streaming/tool-stage latency, credentials, compatibility, ownership and remaining improvements; commit.
- [ ] Fresh final review for both repo ranges; fix Important/Critical findings in one RED→GREEN pass. Keep feature branches for local use.
