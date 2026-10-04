# SoulX Continuous Audio and 20 fps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate within-word silence caused by late SoulX frames and generate SoulX at 20 fps with two denoising steps.

**Architecture:** Keep 50 Hz audio packets and 25 Hz WebRTC video output. SoulX produces 20 positioned frames per second. Its output loop plays a duplicate PCM queue independently of the generated video queue and repeats or drops video frames to follow the audio position.

**Tech Stack:** Python 3.11, NumPy, aiortc, SoulX isolated worker, unittest, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-05-soulx-audio-and-20fps-design.md`

## Global Constraints

- Preserve all existing uncommitted user work and Ditto's buffered 25 fps behavior.
- Keep audio PCM at 16 kHz, 320 samples per packet, and WebRTC/MP4 output at 25 fps.
- SoulX worker must report 20 fps, 24 output frames per 19,200-sample block, and two sampling steps.

## Review Focus

- Interruption mid-inference: queued old PCM or video must never reach the new turn.
- TTS pause mid-phrase: do not permanently advance the video position while the playback queue is empty.
- Short final block: pad only the model input; do not publish padded audio.
- Fast video producer: bounded queue backpressure must not build unbounded latency.
- Long speech under shared-GPU load: video can repeat or drop; audio must remain complete.

---

### Task 1: Worker timing contract and SoulX inference

**Files:** `avatars/generative/soulx_engine.py`, `avatars/generative/worker_client.py`, `scripts/generative_avatar_worker.py`, `tests/test_soulx_engine.py`, `tests/test_generative_worker_client.py`

**Interfaces:** Worker ready includes `fps` and `chunk_samples`. `WorkerClient.render(audio)` accepts exactly `chunk_samples` finite float32 samples. Ditto remains 25 fps with 640 samples per frame.

- [x] Add failing tests for 20 fps SoulX timing and worker sample validation; run them red.
- [x] Configure SoulX `tgt_fps=20`, `frame_num=33`, `sample_steps=2`; pass and validate worker timing; run targeted tests green. A 29-frame window failed on the real checkpoint and was replaced with 33.

### Task 2: Independent PCM playback

**Files:** `avatars/generative/audio_buffer.py`, `avatars/generative_avatar.py`, `tests/test_generative_audio.py`, `tests/test_generative_avatar.py`

**Interfaces:** AudioBuffer assigns a sample position to each accepted packet and exposes a second, generation-tagged playback queue. SoulX generated frames carry the input sample position they animate.

- [x] Add failing tests for audio order with delayed video, 20-to-25 frame mapping, interruption and final padding; run them red.
- [x] Play two PCM packets every 25 fps output tick after the first matching frame is ready; independently choose the newest generated frame at or before the current audio position. Preserve Ditto's existing path; run targeted tests green.

### Task 3: Real media and documentation

**Files:** `desktop/README.md`, `AGENTS.md`, GPU probe files under `/tmp`

- [x] Run all Python tests (171) and desktop tests (33), then `git diff --check`.
- [x] Run SoulX WebRTC/MP4 continuous-audio probe alone and with concurrent Qwen TTS; analyze 20 ms PCM frames for internal silence and check 20 fps source motion/25 fps output timing. Under TTS load, old recording had seven 0.22–0.30 s gaps, new recording had none >=40 ms. WebRTC reconnect succeeded.
- [x] Record observed trade-offs and limitations in README and AGENTS.md. Leave pre-existing changes intact; do not commit unrelated work.
