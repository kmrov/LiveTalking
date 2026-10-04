# SoulX continuous audio and 20 fps generation

## Goal

Keep spoken audio continuous when SoulX video inference misses a frame deadline, and reduce SoulX inference work by generating 20 frames per second with two denoising steps.

## Design

- Qwen TTS and uploaded PCM remain 16 kHz in 20 ms packets. The WebRTC audio clock remains 50 packets per second. WebRTC video remains 25 fps for compatibility; SoulX supplies 20 distinct frames per second, so the output repeats a frame at regular intervals. Ditto and other avatars keep their existing 25 fps path.
- SoulX consumes 1.2 seconds of audio and returns 24 frames per inference call. Its upstream inference parameters become `tgt_fps=20`, `frame_num=33` (9 context + 24 output), and `sample_steps=2`. This checkpoint rejected a 29-frame window in its audio tensor reshape; 33 works on the real model. Validate these actual parameters at worker startup. The worker protocol reports its fps and required audio samples instead of assuming 640 samples per output frame.
- The audio input buffer duplicates accepted, generation-tagged 20 ms packets into a playback queue. In streaming SoulX, the output loop starts only when the first matching generated frame is ready, then plays real PCM on the existing 40 ms audio cadence regardless of video progress. Missing video repeats the latest generated frame. Generated frames carry input sample positions; late frames are dropped so motion rejoins the audio timeline. An empty playback queue during a TTS gap emits silence, and interrupt discards both queues and stale frames.
- Persona, Qwen TTS API, voice reference, and Ditto buffered playback retain their existing contracts. If SoulX buffered playback is enabled manually, its 20 fps frames are expanded to 25 fps before disk replay so every PCM packet remains attached to an output frame. MP4 recording receives the same 25 fps video output and uninterrupted 16 kHz audio that WebRTC sends.

## Verification

- Unit tests prove no synthetic silence appears inside a continuous speech turn when a video block is late; video repeats or skips frames while audio remains ordered. They also cover interruption, short final blocks and worker audio shape validation.
- A real GPU run compares a continuous control signal with and without concurrent Qwen TTS load. Confirm no silence gaps of 40 ms or more inside the signal, while WebRTC and MP4 stay playable. Measure SoulX block time and inspect visual quality of 20 fps / two-step output before claiming the new setting suitable for Studio.
