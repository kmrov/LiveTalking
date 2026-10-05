# SillyTavern Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create Viktor Petrovich in SillyTavern and connect its local API to LiveTalking Studio as a selectable conversation mode.

**Architecture:** A small Node adapter implements the Persona-compatible conversation API and calls SillyTavern's existing character, chat, and streaming generation routes. Electron supervises the local SillyTavern and adapter processes; LiveTalking keeps its existing streaming speech path.

**Tech Stack:** Node.js 22, Electron, built-in HTTP/fetch, SillyTavern 1.19 REST API, Python aiohttp LiveTalking transport.

**Spec:** `docs/superpowers/specs/2026-10-05-sillytavern-studio-design.md`

## Global Constraints

- Bind SillyTavern and adapter to loopback; ports 8001 and 8002 by default.
- Keep Persona conversation data and credentials separate.
- Preserve WebRTC/WHIP, interruption, MP4, and existing profile behavior.
- Do not write a key into profiles or character cards.
- Studio does not install ST dependencies on Start.

## Review Focus

- CSRF cookie rotation: retry one request after a fresh token.
- Duplicate request ID after a network break: one saved user/assistant pair.
- Concurrent turns in one conversation: deterministic order.
- ST card renamed/deleted: explicit recovery error.
- Occupied port with unrelated service: do not adopt or terminate it.

---

### Task 1: SillyTavern HTTP client and card

**Files:** Create `desktop/electron/sillytavern-client.mjs`, `desktop/electron/sillytavern-card.mjs`; test `desktop/test/sillytavern-client.test.mjs`.

**Interfaces:** `createSillyTavernClient({baseUrl, fetch})` exposes `version`, `ensureCard`, `conversations`, `getChat`, `saveChat`, `generate`.

- [ ] Write tests for CSRF/cookie, card creation, standard chat reads/writes and stream chunks; run and see expected failure.
- [ ] Implement client and card installer; run focused tests and verify pass.

### Task 2: Persona-compatible adapter

**Files:** Create `desktop/electron/sillytavern-bridge.mjs`, `desktop/scripts/sillytavern-bridge.mjs`; test `desktop/test/sillytavern-bridge.test.mjs`.

**Interfaces:** `createSillyTavernBridge({client, key, folderId})` exposes an HTTP server with `/api/v1/health`, `/capabilities`, `/conversations`, `/conversations/:id/messages` GET/POST.

- [ ] Write tests for create/list/history/stream, duplicate request ID and model errors; run and see expected failure.
- [ ] Implement adapter with serialized turns and committed chat writes; run focused tests and verify pass.

### Task 3: Profile and process lifecycle

**Files:** Modify `desktop/src/profile.mjs`, `desktop/electron/main.mjs`, `desktop/electron/supervisor.mjs`; create `desktop/electron/sillytavern-supervisor.mjs`; test profile/supervisor files.

**Interfaces:** ST profile mode stores ST URL/root and uses adapter URL; supervisor starts/adopts/stops only owned ST and bridge processes.

- [ ] Write profile, compatibility, readiness, startup and Stop tests; run and see expected failure.
- [ ] Implement mode and lifecycle; run focused tests and verify pass.

### Task 4: Studio UI and documentation

**Files:** Modify `desktop/renderer/studio.html`, `desktop/renderer/studio.mjs`, `desktop/README.md`, `AGENTS.md`; test renderer behavior with smoke where feasible.

**Interfaces:** UI exposes SillyTavern mode, ST path/URL and conversation controls; Persona-only memory UI stays Persona-only.

- [ ] Add UI regression assertions; run and see expected failure.
- [ ] Implement UI and documentation; run focused checks and verify pass.

### Task 5: Local provisioning and full verification

**Files:** SillyTavern local runtime data via its API; no SillyTavern source edits.

- [ ] Install SillyTavern dependencies, start on loopback port 8001, create and inspect Viktor card.
- [ ] Run `npm test`, `npm run build`, smoke and a short local API integration test; report results and limits.
