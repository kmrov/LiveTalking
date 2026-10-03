# Studio → Head in Jar projection verification

Date: 2026-10-03. Working branch: `feat/livetalking-desktop-batya`.

## Delivered

- LiveTalking's local WHIP API accepts the selected avatar, reference voice, and Batya conversation ID and reports its session ID.
- Studio has Head in Jar URL/token controls. Electron main sends only connect/status/disconnect to the active loopback LiveTalking profile; it accepts only the local Head in Jar `/whip` destination. The token is not saved in the profile or returned by status.
- While projection is connected, Studio sends chat, echo, interrupt, recording, speaking checks, and Batya SSE to its WHIP session. ASR remains independent and places recognized text in the same composer. Preview and projection are selected separately.
- On Stop or app quit, main releases the WHIP connection created by this Studio instance; an existing external connection is not adopted. The UI handles stream loss and reconnect.
- Studio creates a UUID session and a separate UUID lease. Status checks both; conditional disconnect returns 409 if another stream replaced it. A disconnect issued during negotiation waits for the connect request to finish before sending the conditional delete. Preview and projection controls lock before Batya history or media negotiation starts.

## Evidence

- Studio `npm test`: 28 test files passed, 0 failed, including pending-connect cancellation and replaced-stream status.
- LiveTalking desktop Python contracts: 49 passed, 0 failed.
- WHIP Python tests: 9 passed, 0 failed, including stale-lease disconnect rejection.
- Studio `npm run smoke`: passed, including projected session routing, interruption, drop/reconnect, delayed preview/projection negotiations, Batya conversation ID and retained history after restart.
- Head in Jar `npm test`: 166 passed, 0 failed; `npm run build`: passed.
- Real cross-application WHIP probe: a synthetic aiortc sender using LiveTalking's `RTCManager.connect_whip` with a UUID session and lease connected to a temporary Head in Jar Electron profile. Head in Jar decoded live 320 × 240 video and reported source status `running`. Probe processes and temporary profile were removed.
- `git diff --check` on changed tracked files passed. Head in Jar working tree remained clean. Existing unrelated LiveTalking edits were preserved.

## Limits

- Only one display was connected during this session. No physical projector calibration or optical output was possible.
- The current profile still selects `wav2lip256_avatar1`; choose the avatar matching the physical head project before the live show.
- The full live GPU/Yandex path microphone → Qwen ASR → Batya → Qwen TTS → projected face and audio was not rerun during this change. Studio's fixture smoke tests routing, while the cross-application probe tests WHIP media compatibility.
