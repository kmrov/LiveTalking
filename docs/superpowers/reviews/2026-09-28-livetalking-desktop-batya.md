# Batya desktop integration verification

Date: 2026-09-28. Main implementation: `6af1690..6edb4eb`, branch `feat/livetalking-desktop-batya`. Batya: `cf60458..b57db19`, branch `feat/livetalking-speech-stream`.

## Delivered

Managed/adopted Batya and persistent PostgreSQL ownership, brain settings and secret bridge, all `/human` chat routed to Batya, stable request/conversation IDs, silent memory tool planning and incremental final speech, interruption, history, conversation selection, memories and explicit text-document upload.

The existing Основной profile now selects Batya. Voice/avatar/autoStart were preserved; a profile backup is `profiles.json.before-batya-20260928`. The current Yandex key comes from the launch environment. When another launch environment lacks it, enter the key in Studio; it is never written to profile JSON.

## Verification

- Main working checkout: 61 Python tests passed; clean committed export: 44 passed.
- Desktop: 52 assertions passed, build passed, real Electron fixture smoke passed, including reconnect during a pending turn, history after restart, error/retry and direct-mode recovery.
- Batya: 64 tests passed against an isolated temporary database; that database was removed.
- A graph → LiveTalking adapter contract check verified that persistence failure followed by a same-ID retry generates once, saves once and speaks the replay once.
- Actual local Batya/PostgreSQL, Yandex, Qwen ASR/TTS and LiveTalking cold startup worked; WebRTC video/audio, stream, interrupt, reconnect and persistent history after Batya API/Electron restart were verified with synthetic conversations.
- Incremental submission to TTS before upstream done is covered by a held-open upstream regression. In the real short-answer run, text streamed for 3422ms and first audible speech followed done by 3446ms. Synthesis can outlast fast text generation; the implementation does not wait for done before submitting phrases.
- An artificial 60-sentence request hit the existing Yandex output budget and returned response.incomplete; speech stopped and UI displayed failure. The 30-sentence timing attempt completed its text but did not establish audible-before-done timing. It is not reported as a passing assertion.
- Existing batya-live-db-1 remained healthy and running. Test-owned API/model processes were stopped. Unrelated local edits, including Batya persona and .gitignore, were preserved.

## Fresh final review

One read-only gpt-6-astra/high review examined both committed ranges. No Critical findings. Four Important findings fixed in one RED→GREEN pass, followed by green suites:

1. Checkpoint persistence-only retry now replays its stable answer as delta before done. Regression: test_speech_checkpoint_replays_answer_after_persistence_failure.
2. Conversation observers replay pending/terminal state to a new SSE subscriber and deliver later deltas/done. Speech stays with the original avatar/generation. Regression: test_reconnect_restores_pending_turn_and_receives_completion_without_speaking, snapshot reducer, actual SSE endpoint test and Electron pending-reconnect smoke.
3. Automatic transport retry is enabled only for idempotent Batya chat. Regression: network retry is enabled only for an idempotent brain.
4. Error cleanup clears audio without invalidating queued uninterrupted turns. Regression: test_error_cleanup_preserves_speech_of_a_queued_uninterrupted_turn.

## Rulings

- Ruling: Continue inline in the existing checkout on a new feature branch — required prepared models and earlier local edits must remain available — cost if wrong: less filesystem isolation; stage only integration changes and dependencies.
- Ruling: Use the approved Batya architecture and current explicit implementation request as authorization for this second increment; retain inline execution — user has already approved the specification and requested implementation — cost if wrong: concrete plan choices must be corrected during review.
- Ruling: Change final-only speech to Batya speech_stream with a separate tool-decision stage, as the user explicitly requested streaming — safe deltas are grouped into phrases and spoken before done — cost if wrong: an extra model request adds startup latency per turn.
- Ruling: Adopt existing Qwen TTS registration, ASR route registration and avatar speech-generation counter as runtime dependencies — a clean checkout must register speech backends and suppress interrupted streamed turns — cost if wrong: a few preexisting dependency hunks are included in this branch.
- Task 6: Ruling: Restart only the actual Batya API and Electron for the persistent-history check after one full model cold start — history ownership is PostgreSQL and the full lifecycle is covered separately — cost if wrong: GPU model startup is not repeated in that particular history assertion.
- Final: Ruling: Avatar creation, managed voice library, WHIP and packaging remain subsequent approved increments — this request implements the Batya increment — cost if wrong: those workflows still require the existing tools.
- Final: Ruling: Keep the existing Batya max_output_tokens=1500 policy; expose incomplete generation as failure and stop affected speech — gateway output-budget configuration is a subsequent improvement — cost if wrong: long answers can fail and need a shorter request.
- Final: Ruling: Leave unrelated persona, .gitignore and local LiveTalking changes outside the reviewed commits — preserve user work — cost if wrong: personal runtime may differ from the clean committed tree, covered separately by working-tree tests.
- Final: Ruling: Treat streaming speech as immediate phrase submission to TTS during deltas, matching the explicit specification; audible startup also includes synthesis latency — real short-answer audio was verified, but before-done audio timing was not established — cost if wrong: a fast short text response can finish before the first sound.
- Task 6: Ruling: Start Batya before Qwen/LiveTalking — reject a broken brain before starting GPU models, consistent with this increment plan — cost if wrong: startup stages follow that order rather than the original vision sequence.

## Deferred minors

- Final: minor (deferred): Generation errors use the inherited generic generation_failed code; specific safe Russian recovery instructions remain to add.
- Final: minor (deferred): README names /health instead of the actual /api/v1/health endpoint; runtime health checks use the correct endpoint.
