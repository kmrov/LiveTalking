<p align="center">
  <img src="./assets/LiveTalking-logo.png" alt="LiveTalking" width="600">
</p>

**English** · [中文](./README-ZH.md) · [LiveTalking Studio guide (Русский)](./desktop/README.md)

# LiveTalking and LiveTalking Studio

LiveTalking is a real-time talking-avatar engine. It turns text or speech into synchronized video and audio and can stream the result through WebRTC, RTMP, or a virtual camera. This fork also includes **LiveTalking Studio**, a Linux Electron app for running and using a local LiveTalking setup.

Studio brings avatar selection and creation, Qwen speech services, conversation, recording, and process control into one window. The Python server and its web pages remain available for users who prefer the command line or want to integrate through HTTP APIs.

| Start here | What it provides |
| --- | --- |
| [LiveTalking Studio](#livetalking-studio) | Linux desktop interface for setup, avatars, voice conversation, recording, and projection |
| [Python server and web UI](#python-server-and-web-ui) | Direct access to LiveTalking transports, web pages, and APIs |
| [API documentation](#documentation) | WebRTC sessions, avatar jobs, administration, and virtual camera integration |

## LiveTalking Studio

Studio runs from this source checkout. It requires **Linux with a graphical session and Node.js 22 or newer**. There is currently no AppImage or `.deb` package in this repository.

```bash
git clone https://github.com/kmrov/LiveTalking.git
cd LiveTalking/desktop
npm ci
npm start
```

If installation scripts were disabled and Electron reports that it is missing, run `node node_modules/electron/install.js` from `desktop/`, then start again.

Studio finds the surrounding LiveTalking checkout and guides you through its Python path, avatar, speech services, and voice sample. The interface is currently in Russian: **Проверить** (Check) reports missing prerequisites, and **Запустить** (Start) launches compatible local services or connects to services already running. Studio downloads missing model weights when needed, but Python, CUDA, vLLM, vLLM-Omni, and other software dependencies must be installed separately. A local avatar requires an NVIDIA GPU even if speech servers run elsewhere.

For local speech, Studio uses `Qwen/Qwen3-ASR-0.6B` with vLLM and `Qwen/Qwen3-TTS-12Hz-1.7B-Base` with vLLM-Omni. It can also connect to existing ASR and TTS servers. A voice sample consists of a WAV file and a matching transcript; keep the source WAV in place because the profile refers to it. See the [Studio setup guide](./desktop/README.md) for environment layout, model setup, ports, and first-run steps.

### What Studio can do

- Browse prepared avatars, or create MuseTalk avatars from an image or video and Wav2Lip avatars from video. Avatar preparation can happen before speech or conversation is configured.
- Preview the avatar over WebRTC, send text to an LLM or directly to TTS, speak through the microphone, interrupt speech, and save MP4 recordings.
- Use continuous voice conversation: Studio detects the end of a spoken phrase, sends it to ASR, and resumes listening after the avatar answers. Optional interruption during playback depends on microphone echo cancellation.
- Connect to an optional **Persona** service for persistent conversations, memory, and documents. Persona is a separate project with its own Python environment, PostgreSQL with pgvector, and Yandex AI Studio setup.
- Send the avatar to **Head in Jar** over WHIP. Discovery, connection, and the physical projection step are described in the [Studio guide](./desktop/README.md#проекция-через-head-in-jar).

Studio stops only the processes and database containers it started. Already running compatible services are left running. Profiles live in Electron user data; secrets use the Linux keyring when available and otherwise remain in memory until the app closes.

### Desktop checks

From `desktop/`:

```bash
npm test
npm run build
npm run smoke
```

`npm run build` creates renderer files in `desktop/dist/`; it does not produce an installer. The smoke test uses a fixture server and does not require model weights or a GPU, but it does need an environment capable of launching Electron.

## Python server and web UI

The Python server can be run without Studio. Set up a Python environment and a compatible CUDA/PyTorch stack for the avatar model you choose, then install the project dependencies. The example below uses the prepared Wav2Lip avatar from the original LiveTalking quick start: it expects `models/wav2lip.pth` and `data/avatars/wav2lip256_avatar1` to exist.

```bash
cd /path/to/LiveTalking
python3.12 -m venv .venv
source .venv/bin/activate
# Install a CUDA-compatible PyTorch build for your system first.
pip install -r requirements.txt
python app.py --transport webrtc --model wav2lip --avatar_id wav2lip256_avatar1
```

Open `http://127.0.0.1:8010/index-en.html` for the English web client. The server also includes [avatar creation](./web/avatar-en.html), [administration](./web/admin-en.html), and [virtual camera](./web/virtualcam-en.html) pages. Server-side model and CUDA dependencies vary by avatar and speech backend; consult the relevant model instructions before starting the server.

For a Qwen voice setup without Studio, see the [Qwen ASR/TTS avatar guide](./docs/qwen3-voice-avatar.md) and [Qwen TTS guide](./docs/qwen3-tts.md) (both in Russian). The combined launcher exposes its options with `python scripts/start_qwen_avatar.py --help`.

## Documentation

| Guide | Covers |
| --- | --- |
| [Studio guide](./desktop/README.md) | Setup, avatars, speech, Persona, projection, troubleshooting, and checks (Russian) |
| [API reference](./docs/api-en.md) | WebRTC, text and audio input, recording, and actions |
| [Avatar API](./docs/avatar_api-en.md) | Avatar creation jobs and status |
| [Admin API](./docs/admin_api-en.md) | Configuration and session monitoring |
| [Virtual camera guide](./docs/virtualcam_guide-en.md) | Virtual camera setup and troubleshooting |

The core flow is **text or speech → optional LLM → speech synthesis → avatar rendering → audio/video output**. LiveTalking supports Wav2Lip, MuseTalk, Ultralight, and other avatar backends; Studio's creation and selection options are documented in its own guide.

## Project layout

| Path | Purpose |
| --- | --- |
| `desktop/` | LiveTalking Studio Electron app and tests |
| `app.py`, `server/` | Python server, routes, and session handling |
| `avatars/`, `tts/` | Avatar and speech adapters |
| `web/` | Browser clients |
| `scripts/` | Launchers and avatar/model preparation workers |
| `docs/` | API and setup guides |

## Origin and license

This repository builds on [lipku/LiveTalking](https://github.com/lipku/LiveTalking). The project is distributed under the [Apache 2.0 license](./LICENSE). For the original Chinese project overview, see [README-ZH.md](./README-ZH.md).

If you use the underlying LiveTalking framework in research, cite the upstream project:

```bibtex
@software{livetalking,
  author = {Hengzhong Li},
  title = {LiveTalking: Real-Time Interactive Streaming Digital Human Framework},
  year = {2025},
  publisher = {GitHub},
  url = {https://github.com/lipku/livetalking}
}
```
