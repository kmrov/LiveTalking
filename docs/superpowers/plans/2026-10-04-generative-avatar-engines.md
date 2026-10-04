# Generative avatar engines implementation plan

**Goal:** Try Ditto and SoulX FlashHead Lite as selectable Studio engines with existing speech and transport.

**Spec:** ../specs/2026-10-04-generative-avatar-engines-design.md

**Architecture:** Isolated inference workers, shared synchronized audio/video adapter, existing avatar library and supervisor. Engine dependencies stay outside the LiveTalking environment.

## Global constraints

- Model IDs `ditto` and `soulx`; 25 fps, mono float32 16 kHz; one generative session.
- Preserve existing MuseTalk, Wav2Lip, Ultralight, Qwen, Persona, WebRTC/WHIP, and MP4 behavior.
- English UI, Russian explanations; never modify user source assets or active profile automatically.
- Persistent model workers, explicit errors, bounded buffering, owned-process cleanup and interruption.

## Tasks

- [x] Ditto backend: implement `avatars/generative/ditto_engine.py` with `Engine(config)`, `start(source)`, `chunk_frames`, `render(audio)` returning aligned RGB uint8 frames, `reset()`, `close()`. Inspect pinned upstream APIs, install isolated environment/weights, run real sample and document measured constraints.
- [x] SoulX backend: same interface in `avatars/generative/soulx_engine.py`, using Lite streaming cache. Separate environment and weights, real sample and measured constraints.
- [x] Shared protocol and runtime: `scripts/generative_avatar_worker.py`, `avatars/generative_avatar.py`, protocol/client utilities and tests. Register engines in app/config. Test short utterances, stale output on interruption, protocol failures and shutdown.
- [x] Studio: image creation contract, worker preparation, library validation, engine prerequisites, speech-download compatibility and UI options. Test image/video restrictions and marker consistency.
- [x] Integration: install trial avatars, run both real workers, npm tests/build and applicable smoke, Python tests, review changes, update README and AGENTS with actual evidence.

## Review focus

Audio/video correspondence across engine chunks and final padding; interruption during inference; stale subprocesses on session close; runtime/weight readiness rather than mere config existence; fixed source geometry for projection and accurate limitations of model benchmarks.

## Verification, 2026-10-04

- Both pinned runtimes installed; separate trial avatars prepared without changing the active profile.
- Ditto GPU: 7.92 fps, 8290 MiB Torch reserved plus ONNX; buffered playback. SoulX Lite: 36.61 fps, 5628 MiB Torch reserved; streaming enabled.
- Real LiveTalking WebRTC, uploaded WAV playback, MP4, disconnect and reconnect passed for both. First audible audio: Ditto 6.98s, SoulX 2.11s.
- Full Python suite: 155 tests passed; subsequent idle-gap fallback regression also passed. Node suite: 155 tests passed. Build, Electron smoke and smoke:ui passed; isolated new-model form/caption checks passed.
- Independent review fixed stale Qwen deliveries, worker lifetime, end-marker reset, render error reporting, TTS-gap padding and partial-input speaking status.
- Local Qwen ASR/TTS + real echo speech/WebRTC/MP4 passed for both with default memory settings: total GPU peak SoulX 19503 MiB, Ditto 23776 MiB/24576. Cold combined SoulX startup114.3s and first audio16.34s; Ditto with existing Qwen first audio18.19s. Owned launchers shut down with cleanup. Physical projection and sustained load remain untested.
