# LiveTalking Desktop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Linux Electron application that checks a local LiveTalking setup, starts its Qwen speech and avatar services, and supports an in-app WebRTC conversation with text, microphone, interrupt, and recording controls.

**Architecture:** A secure Electron main process owns profiles, prerequisite checks, and one Python supervisor process. The renderer has a narrow preload API for desktop operations and uses LiveTalking's HTTP, WebSocket, and WebRTC endpoints for media and conversation. This plan implements the first working increment; separate plans will implement Batya, asset management, outgoing WHIP, and packaging from the same spec.

**Tech Stack:** Linux, Electron 44.4.5, Node.js >=22, esbuild 0.28.2, vanilla JavaScript modules, Python LiveTalking/Aiohttp, Node test runner, Python unittest, Playwright desktop smoke test.

**Spec:** `docs/superpowers/specs/2026-09-28-livetalking-desktop-design.md`

## Global Constraints

- The app runs on Linux first. It does not bundle Python, CUDA, databases, or model weights.
- Local services start automatically after a successful initial setup, with an explicit Stop control and an auto-start setting.
- The app-managed LiveTalking server binds to `127.0.0.1`; the existing CLI default remains compatible.
- Stop and quit terminate only processes started by this app; already running compatible services stay running.
- Renderer IPC cannot execute arbitrary commands or read arbitrary files. Keys never enter profile JSON, process command lines, or diagnostic logs.
- The UI uses a dark, restrained workspace language inspired by Head in Jar without copying its code or assets.
- Preserve existing user edits in the LiveTalking working tree; stage only files belonging to each task.

## Review Focus

- A checkout or WAV path with spaces and non-ASCII characters must reach Python unchanged; Task 3 and Task 5 test this.
- An unrelated process on port 8010 must block startup with a specific port-conflict result; Task 4 tests this.
- A corrupt saved profile must not prevent the setup screen from opening; Task 3 tests this.
- WebRTC failure after connection must clear the session ID and disable recording; Task 7 and Task 8 test this.
- A rejected microphone permission or ASR error must stop capture and keep text entry usable; Task 9 tests this.

## File map

| File or group | Responsibility |
| --- | --- |
| `config.py`, `app.py`, `server/routes.py` | Configurable listen host and a small, versioned readiness endpoint. |
| `scripts/start_qwen_avatar.py` | Existing supervisor CLI, extended with machine-readable lifecycle events. |
| `desktop/electron/main.mjs`, `preload.cjs`, `ipc-policy.mjs` | Window lifecycle and privileged, validated desktop operations. |
| `desktop/electron/profile-store.mjs`, `secret-store.mjs` | Atomic user profile storage and session/desktop-secret handling. |
| `desktop/electron/prerequisites.mjs`, `supervisor.mjs` | Linux setup probes and ownership-aware process lifecycle. |
| `desktop/src/profile.mjs`, `service-state.mjs` | Pure profile validation and status transitions. |
| `desktop/renderer/studio.*`, `webrtc-client.mjs`, `conversation-client.mjs`, `asr-client.mjs` | Local UI, in-app media, text/audio commands, and microphone capture. |
| `desktop/test/*.test.mjs`, `desktop/scripts/smoke-electron.mjs`, `tests/test_desktop_*.py` | Focused checks and one desktop end-to-end smoke workflow. |

---

### Task 1: Desktop readiness contract in LiveTalking

**Files:** Modify `config.py`, `app.py`, `server/routes.py`; create `tests/test_desktop_health.py`.

**Interfaces:** Produce `GET /api/desktop/health` returning `{"code":0,"msg":"ok","data":{"service":"livetalking","api_version":1}}`; produce `--listenhost` with CLI default `0.0.0.0`. `app.py` passes `opt.listenhost` to `web.TCPSite`.

- [ ] **Step 1: Write failing Python tests** in `tests/test_desktop_health.py`: `parse_args()` accepts `--listenhost 127.0.0.1` and retains `0.0.0.0` by default; `desktop_health()` returns the exact versioned payload.
- [ ] **Step 2: Verify red:** run `.venv/bin/python -m unittest discover -s tests -p 'test_desktop_health.py' -v`; expect missing option/handler failures.
- [ ] **Step 3: Implement the two interfaces** and register the route before static file handling. Keep the existing CLI behavior for callers that omit `--listenhost`.
- [ ] **Step 4: Verify green:** rerun the focused unittest command, then `.venv/bin/python -m unittest discover -s tests -p 'test_whip*.py' -v`; expect zero failures.
- [ ] **Step 5: Commit** only the four task files with `feat: add desktop readiness endpoint and loopback option`.

### Task 2: Secure Electron shell and local build

**Files:** Create `desktop/package.json`, `desktop/package-lock.json`, `desktop/scripts/build.mjs`, `desktop/electron/main.mjs`, `desktop/electron/preload.cjs`, `desktop/electron/ipc-policy.mjs`, `desktop/renderer/studio.html`, `desktop/renderer/studio.css`, `desktop/renderer/studio.mjs`, `desktop/test/ipc-policy.test.mjs`; modify `.gitignore` for desktop build outputs and node modules.

**Interfaces:** `createStudioWindow()` opens a local packaged renderer with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; `isTrustedStudioSender(event, window, expectedUrl)` gates every IPC handler. Preload exposes `window.liveTalkingDesktop` with no generic command or file API. Builds output to `desktop/dist/`.

- [ ] **Step 1: Write failing `ipc-policy.test.mjs` cases**: the expected studio URL and webContents ID are accepted; another URL, another webContents, and navigation to a remote URL are rejected.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='IPC policy' test/*.test.mjs`; expect module or assertion failure.
- [ ] **Step 3: Implement the shell, policy, preload stub, and build** with pinned Electron/esbuild versions and `npm start`, `npm test`, `npm run build` scripts. Deny new windows and navigation away from the local renderer. Allow microphone permission only for the trusted studio window.
- [ ] **Step 4: Verify green:** run `cd desktop && npm test && npm run build`; launch `npm start` in a desktop session and confirm a dark empty Studio window opens.
- [ ] **Step 5: Commit** only shell/build/test files with `feat: scaffold secure LiveTalking desktop shell`.

### Task 3: Validated profiles and secret boundaries

**Files:** Create `desktop/src/profile.mjs`, `desktop/electron/profile-store.mjs`, `desktop/electron/secret-store.mjs`, `desktop/electron/discover-root.mjs`, `desktop/test/profile.test.mjs`, `desktop/test/profile-store.test.mjs`, `desktop/test/secret-store.test.mjs`, `desktop/test/discover-root.test.mjs`.

**Interfaces:** `normalizeProfile(input)` returns a profile with `id`, `liveTalking:{root,python,model,avatarId,port}`, `speech:{mode,asrVllm,ttsVllm,asrUrl,ttsUrl,referenceWav,referenceText}`, `llm:{provider,model,promptFile}`, `autoStart`; it throws `ProfileError` with a field name for invalid input. `discoverLiveTalkingRoot({appPath, executablePath, appImagePath, exists})` finds the parent checkout in development or a `LiveTalking` sibling of the AppImage/executable in an installation; a saved user override takes precedence. `createProfileStore(userDataPath)` exposes `list()`, `get(id)`, `save(profile)`, `remove(id)`, `lastSuccessfulId()`, and `setLastSuccessfulId(id)` and quarantines invalid JSON. `createSecretStore({safeStorage,backend})` exposes `set/get/delete` and stores keys only if the Linux backend is a real desktop secret service, otherwise in memory for the current session.

- [ ] **Step 1: Write failing tests** for a valid Unicode/spaced path, invalid port and profile ID, JSON containing no key value, an atomically replaced profile file, the last-successful ID round trip, and a corrupt file that yields an empty setup state plus a recoverable error. Test checkout discovery in development and beside an AppImage, missing checkout, and explicit override.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='profile|secret|discover' test/*.test.mjs`; expect missing modules or assertions.
- [ ] **Step 3: Implement the four modules** with explicit schema version `1` and app-owned per-user storage; persist only nonsecret profile fields.
- [ ] **Step 4: Verify green:** rerun the focused tests and `npm test`; expect zero failures.
- [ ] **Step 5: Commit** only the profile/secret modules and tests with `feat: persist validated desktop profiles`.

### Task 4: Guided Linux setup checks

**Files:** Create `desktop/electron/prerequisites.mjs`, `desktop/test/prerequisites.test.mjs`; modify `desktop/electron/main.mjs`, `desktop/electron/preload.cjs`, and `desktop/renderer/studio.*`.

**Interfaces:** `inspectPrerequisites(profile, probes)` returns ordered `[{id,state,detail,action}]` for checkout, Python imports, reference WAV/transcript, model files, ASR/TTS endpoint or executables, GPU for local inference, and port 8010. `state` is `ready`, `missing`, or `blocked`. Preload exposes `checkSetup(profile)` and `saveProfile(profile)` only for the trusted window.

- [ ] **Step 1: Write failing tests** using injected filesystem/process/network probes: missing Python shows the exact path and recovery command; an unrelated listener on 8010 is `blocked`; a compatible LiveTalking health reply is `ready`; external ASR/TTS mode does not require local vLLM executables.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='prerequisite' test/*.test.mjs`; expect failure.
- [ ] **Step 3: Implement probes and the first-run screen** with each check, its result, and its concrete next action. Start with the discovered LiveTalking root; show “Choose another folder” only as a secondary action, and offer it as recovery if discovery fails. Validate renderer-provided paths and URLs before probing.
- [ ] **Step 4: Verify green:** rerun focused tests and `npm run build`; manually inspect the setup screen with a missing path and with the current checkout.
- [ ] **Step 5: Commit** only setup files with `feat: guide Linux LiveTalking setup`.

### Task 5: Structured supervisor status and owned shutdown

**Files:** Modify `scripts/start_qwen_avatar.py`, `tests/test_start_qwen_avatar.py`; create `desktop/electron/supervisor.mjs`, `desktop/test/supervisor.test.mjs`.

**Interfaces:** `--json-status` adds lines prefixed `LT_STATUS ` followed by JSON `{stage,state,detail}`. Stages are `asr`, `tts`, `livetalking`; states are `starting`, `ready`, `failed`, `stopped`. The existing human-readable CLI stays intact. `createSupervisor({spawn,kill,health,emit})` exposes `start(profile)`, `stop()`, `snapshot()` and never kills adopted services. It passes `--listenhost 127.0.0.1` to LiveTalking; `speech.mode === 'external'` maps to the supervisor's `--external-models`, `--asr-server`, and `--tts-server` arguments.

- [ ] **Step 1: Write failing Python tests** for the exact JSON prefix/events and unchanged dry-run output; write Node tests with a fake child for no duplicate start, SIGTERM of the owned supervisor, adopted service preservation, loopback and external-model arguments, and argv containing a spaced Unicode WAV path as one argument.
- [ ] **Step 2: Verify red:** run `.venv/bin/python -m unittest discover -s tests -p 'test_start_qwen_avatar.py' -v` and `cd desktop && node --test --test-name-pattern='supervisor' test/*.test.mjs`; new assertions must fail.
- [ ] **Step 3: Add status emission at existing lifecycle boundaries** and implement the Node supervisor using argument arrays, process-group ownership, bounded shutdown, and polling `/api/desktop/health` before declaring LiveTalking ready.
- [ ] **Step 4: Verify green:** rerun both focused suites; run the Python script with `--dry-run --json-status` and test reference arguments to confirm it does not start services.
- [ ] **Step 5: Commit** only supervisor files with `feat: supervise local LiveTalking services`.

### Task 6: Desktop lifecycle and visible status

**Files:** Create `desktop/src/service-state.mjs`, `desktop/test/service-state.test.mjs`; modify `desktop/electron/main.mjs`, `desktop/electron/preload.cjs`, `desktop/renderer/studio.*`.

**Interfaces:** `transitionServiceState(state,event)` yields `not-configured`, `checking`, `starting`, `ready`, `reconnecting`, or `failed`; the main process exposes `startProfile(id)`, `stopProfile()`, `getSnapshot()`, and a one-way `onSnapshot` subscription through preload. `autoStart` launches the last successful profile after window readiness, once.

- [ ] **Step 1: Write failing state tests** for start/ready/failure/retry/stop, duplicate Start, child exit, and profile change during startup.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='service state' test/*.test.mjs`; expect failure.
- [ ] **Step 3: Wire profile store, setup checks, and supervisor** to the trusted IPC; render separate ASR/TTS/LiveTalking states, Start/Stop, retry, and log excerpt. Close the app by stopping owned processes once.
- [ ] **Step 4: Verify green:** rerun `npm test && npm run build`; manually launch with the current profile and verify the status sequence and a clean Stop.
- [ ] **Step 5: Commit** only lifecycle files with `feat: manage desktop startup lifecycle`.

### Task 7: In-app WebRTC avatar preview

**Files:** Create `desktop/renderer/webrtc-client.mjs`, `desktop/test/webrtc-client.test.mjs`; modify `desktop/renderer/studio.*`.

**Interfaces:** `createWebRtcClient({RTCPeerConnection,fetch,baseUrl,onState,onTrack})` exposes `connect({avatarId,referenceWav,referenceText})`, `disconnect()`, `sessionId()`. It sends an SDP offer to `/offer`, applies the answer, receives video/audio tracks, and clears the session ID on failed/closed connection.

- [ ] **Step 1: Write failing tests** with a fake peer connection for offer parameters, returned session ID, remote track delivery, connection failure, and disconnect while a session is active.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='WebRTC client' test/*.test.mjs`; expect failure.
- [ ] **Step 3: Implement the client and central player** with Connect/Disconnect, visible media/error states, and a responsive dark stage. Keep the renderer's media source separate from the service process state.
- [ ] **Step 4: Verify green:** rerun focused tests and build; manually connect to the running local avatar and verify video plus audio.
- [ ] **Step 5: Commit** only player files with `feat: preview avatar through WebRTC`.

### Task 8: Text conversation, interrupt, and recording

**Files:** Create `desktop/renderer/conversation-client.mjs`, `desktop/test/conversation-client.test.mjs`; modify `desktop/electron/main.mjs`, `desktop/electron/preload.cjs`, `desktop/renderer/studio.*`.

**Interfaces:** `createConversationClient({fetch,baseUrl,getSessionId})` exposes `sendText(text,{type,interrupt})`, `interrupt()`, `startRecording()`, `stopRecording()`, and `speaking()`. It rejects commands without an active session, checks LiveTalking's JSON `code`, and uses the current session ID for every call. Preload adds only `saveRecording(sessionId)`: the main process validates the ID, fetches `/record/{sessionId}` from the configured loopback server, and writes the response to an MP4 path chosen in a save dialog.

- [ ] **Step 1: Write failing tests** for echo/chat payloads, an interrupt request, start/stop recording, nonzero API code, and a lost WebRTC session that disables further recording commands.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='conversation client' test/*.test.mjs`; expect failure.
- [ ] **Step 3: Implement API client and conversation controls** with text entry, echo/chat selector, interrupt, speaking indicator, record toggle, and a save dialog for the completed MP4.
- [ ] **Step 4: Verify green:** rerun focused tests and build; manually send one echo turn, one direct LLM chat turn, interrupt speech, and record/download a short clip.
- [ ] **Step 5: Commit** only conversation files with `feat: control avatar conversation and recording`.

### Task 9: Microphone transcription

**Files:** Create `desktop/renderer/asr-client.mjs`, `desktop/renderer/pcm-worklet.js`, `desktop/test/asr-client.test.mjs`; modify `desktop/renderer/studio.*`.

**Interfaces:** `createAsrClient({getUserMedia,AudioContext,WebSocket,baseUrl,onState,onText})` exposes `start()`, `stop()`, `dispose()`. It sends a JSON start message, mono PCM16 at 16 kHz in binary WebSocket frames to `/api/asr`, then a JSON stop message; only a nonempty final transcript enables Send. `createPcmResampler(inputRate,outputRate=16000)` exposes `push(Float32Array) -> Int16Array` and `flush() -> Int16Array`, preserving sample count across input chunks. Audio tracks close on all exit paths.

- [ ] **Step 1: Write failing tests** for start/stop message order, final text, WebSocket error, and rejected microphone permission; add a pure resampling test that maps one second of 48 kHz mono input to 16,000 signed samples without clipping overflow.
- [ ] **Step 2: Verify red:** run `cd desktop && node --test --test-name-pattern='ASR client|PCM' test/*.test.mjs`; expect failure.
- [ ] **Step 3: Implement capture, conversion, and mic controls** using an AudioWorklet and local WebSocket. Keep text entry usable if capture fails; pressing Stop waits for the final ASR result before offering Send.
- [ ] **Step 4: Verify green:** rerun focused tests and build; manually record a Russian sentence, inspect the transcript, and send it to the avatar.
- [ ] **Step 5: Commit** only ASR files with `feat: transcribe desktop microphone input`.

### Task 10: Foundation smoke test and operator documentation

**Files:** Create `desktop/scripts/smoke-electron.mjs`, `desktop/scripts/fixture-server.mjs`, `desktop/README.md`; modify `desktop/package.json` with `smoke` script.

**Interfaces:** `npm run smoke` launches Electron with `LIVETALKING_DESKTOP_TEST_FIXTURE=1` and a local fixture server for `/api/desktop/health`, `/offer`, `/human`, and `/interrupt_talk`. In that test-only mode, the renderer receives a fake `RTCPeerConnection` through the WebRTC client's injected constructor. The smoke script checks setup, Start, connected session ID, text send, interruption, and Stop, then writes screenshots and logs under ignored `desktop/test-results/`.

- [ ] **Step 1: Write the smoke script** with assertions for the complete fixture workflow and a nonzero exit on any failed state; add a corrupt-profile startup case.
- [ ] **Step 2: Verify red:** run `cd desktop && npm run smoke`; expect failure until the fixture and wiring are complete.
- [ ] **Step 3: Complete fixture wiring and document Linux setup** with checkout/Python/model prerequisites, startup, log location, and the limits of this first increment.
- [ ] **Step 4: Verify green:** run `cd desktop && npm test && npm run build && npm run smoke` in a desktop session; run `.venv/bin/python -m unittest discover -s tests -p 'test_desktop_health.py' -v` and `.venv/bin/python -m unittest discover -s tests -p 'test_start_qwen_avatar.py' -v`; expect zero failures. Then manually repeat cold start, text, mic, record, and clean shutdown with real services.
- [ ] **Step 5: Commit** only smoke/docs files with `test: verify LiveTalking desktop foundation`.

## Handoff to subsequent plans

After this increment works, write separate plans against the same approved spec for (1) Batya service startup and all-chat adapter with persistent conversation IDs, (2) Qwen voice profiles, avatar generation, direct LLM settings, and outgoing WHIP, and (3) diagnostics, Linux AppImage/`.deb` packaging, and release checks. Each plan must preserve the interfaces produced here and end in a running desktop workflow.
