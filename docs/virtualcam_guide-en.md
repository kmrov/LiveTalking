# Virtual Camera Guide

## Quick start

### 1. Start the server

```bash
python app.py --transport virtualcam --model wav2lip --avatar_id wav2lip256_avatar1
```

Install OBS Studio to provide the **OBS Virtual Camera** device. Start OBS Studio once after installation so the virtual camera device becomes available.

### 2. Open the control page

Visit **http://localhost:8010/virtualcam-en.html** in a browser.

### 3. Control the avatar

- Enter text and click **Send text** to make the avatar speak.
- Click **Interrupt speech** to stop the current speech.
- Use `Ctrl+Enter` to send text or `Escape` to interrupt.

### 4. Use the video in another application

Choose **OBS Virtual Camera** as the camera in Zoom, Teams, or another video application. The screenshot below shows the camera selection in Tencent Meeting:

![Virtual camera selected in Tencent Meeting](image/virtualcam_guide/1782554830929.png)

The virtual camera carries **video only**. LiveTalking plays speech through a system audio output device; configure audio capture or routing separately if the other application must receive the speech.

---

## Overview

### Features

- Background rendering without a browser video connection.
- Automatic selection of the system's default audio output device.
- BGR-to-RGB conversion for correct video colors.
- A web control page and HTTP API.
- A speaking status indicator on the control page.

### Output modes

| Mode | Option | Description |
|------|--------|-------------|
| Virtual camera | `--transport virtualcam` | Render in the background and send video to OBS Virtual Camera |
| WebRTC | `--transport webrtc` | Send audio and video to a browser |

---

## Installation and configuration

### How OBS and pyvirtualcam work together

- **OBS Studio** supplies the virtual camera device driver.
- **pyvirtualcam** sends rendered video frames to that device.
- **Zoom, Teams, and other apps** read video from the device.

Flow: OBS provides the device → pyvirtualcam sends frames → the other app reads the frames.

### Set up the camera device

1. Download and install [OBS Studio](https://obsproject.com/).
2. Launch OBS Studio once after installation to make its virtual camera device available.
3. Verify that Python can open the device:

   ```python
   import pyvirtualcam

   try:
       cam = pyvirtualcam.Camera(width=640, height=480, fps=30)
       print(f"Success: {cam.device}")  # Expected: OBS Virtual Camera
       cam.close()
   except Exception as e:
       print(f"Failed: {e}")
   ```

The device remains registered after OBS closes and after a system restart, provided the driver is installed correctly.

### Install Python dependencies

```bash
pip install pyvirtualcam pyaudio
```

### Use the default audio output device

```bash
python app.py --transport virtualcam --model wav2lip --avatar_id wav2lip256_avatar1
```

### Choose an audio output device manually

```bash
# 1. List audio output devices
python list_audio_devices.py

# 2. Pass the chosen device index
python app.py --transport virtualcam --audio_output_device 25
```

### Use YAML configuration

```yaml
# config.yaml
transport: virtualcam
model: wav2lip
avatar_id: wav2lip256_avatar1
audio_output_device: 25  # Optional
```

```bash
python app.py  # Loads config.yaml automatically
```

---

## Control page

Visit **http://localhost:8010/virtualcam-en.html**.

| Section | What it does |
|---------|--------------|
| Status | Shows whether session `0` is speaking; device labels are displayed on the page |
| Speech output | Send text, interrupt speech, or use quick phrases |
| History | Stores up to 20 sent messages locally; click one to send it again |

Configuration comes from startup options; the control page does not change the avatar, TTS plugin, or audio device.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Send text |
| `Escape` | Interrupt speech |

### HTTP API examples

```bash
# Send text
curl -X POST http://localhost:8010/human \
  -H "Content-Type: application/json" \
  -d '{"sessionid":"0","type":"echo","text":"Hello"}'

# Interrupt speech
curl -X POST http://localhost:8010/interrupt_talk \
  -H "Content-Type: application/json" \
  -d '{"sessionid":"0"}'

# Check whether the avatar is speaking
curl -X POST http://localhost:8010/is_speaking \
  -H "Content-Type: application/json" \
  -d '{"sessionid":"0"}'

# Get server configuration and active sessions
curl http://localhost:8010/api/admin/config
curl http://localhost:8010/api/admin/sessions
```

---

## Audio output devices

Run:

```bash
python list_audio_devices.py
```

Example output:

```text
[Output Devices]:

Device Index: 5
  Name: Speakers (2- Realtek(R) Audio)
  Output Channels: 2

Device Index: 25
  Name: Speakers (2- Realtek(R) Audio)
  Host API: Windows WASAPI
```

Device selection tips:

1. Prefer a WASAPI device on Windows for lower latency (often indices 22–27).
2. Use a DirectSound device for compatibility (often indices 15–21).
3. Omit `--audio_output_device` to let LiveTalking select the system default.

Device indices depend on the machine; use the list shown on your system.

---

## Troubleshooting

### Q1: No sound

1. Look for the selected device in the startup log:

   ```text
   [VirtualCam Audio] Using default output device: Speakers (index 25)
   ```

2. Confirm that the device index is an output device:

   ```bash
   python list_audio_devices.py
   ```

3. If needed, select it explicitly:

   ```bash
   python app.py --transport virtualcam --audio_output_device 25
   ```

4. Confirm that TTS is generating audio; the logs may show `doubao tts Time to first chunk`.

### Q2: The picture looks blue

The output code converts BGR frames to RGB before sending them to pyvirtualcam.

### Q3: `RuntimeError: virtual camera output could not be started`

The virtual camera device is not registered or available. Install OBS Studio, launch it once, and check the device:

```python
import pyvirtualcam
cam = pyvirtualcam.Camera(width=640, height=480, fps=30)
print(cam.device)  # Expected: OBS Virtual Camera
cam.close()
```

### Q4: `ModuleNotFoundError: No module named 'pyaudio'`

```bash
pip install pyaudio
# Alternatively, on supported Windows setups:
pip install pipwin && pipwin install pyaudio
```

### Q5: `ModuleNotFoundError: No module named 'pyvirtualcam'`

```bash
pip install pyvirtualcam
```

### Q6: How do I check that the virtual camera works?

1. Look for a startup message such as:

   ```text
   VirtualCam output started: OBS Virtual Camera with resolution 1280x720
   ```

2. In OBS or another application, select **OBS Virtual Camera** as a video capture device. The avatar should appear.
3. Send a test message:

   ```bash
   curl -X POST http://localhost:8010/human -H "Content-Type: application/json" -d '{"sessionid":"0","type":"echo","text":"Test"}'
   ```

### Q7: Audio has high latency

Try a WASAPI output device on Windows, close other audio applications, and check CPU usage.

---

## Architecture

### Rendering flow

```text
app.py
  └─> Create session 0
      └─> render() thread
          └─> inference() generates frames
              └─> process_frames() outputs frames
                  └─> virtualcam.py
                      ├─> Video: BGR → RGB → pyvirtualcam
                      └─> Audio: PyAudio → output device
```

### API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/human` | POST | Send text |
| `/interrupt_talk` | POST | Interrupt speech |
| `/is_speaking` | POST | Check speaking status |

### Key files

| File | Purpose |
|------|---------|
| `config.py` | CLI options |
| `app.py` | Startup logic |
| `avatars/base_avatar.py` | Rendering threads |
| `streamout/virtualcam.py` | Virtual camera output |
| `web/virtualcam-en.html` | English web control page |
| `list_audio_devices.py` | Audio device listing tool |
