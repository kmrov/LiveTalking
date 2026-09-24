# Admin API Reference

Base URL: `http://<host>:<listenport>`

---

## 1. Get global configuration

```http
GET /api/admin/config
```

Returns the global configuration used when the server started, including CLI options.

**Request parameters:** None.

**Response:**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "config": {
      "fps": 25,
      "l": 10,
      "m": 8,
      "r": 10,
      "model": "wav2lip",
      "avatar_id": "wav2lip256_avatar1",
      "data_path": "data/avatars",
      "batch_size": 16,
      "modelres": 192,
      "modelfile": "",
      "customvideo_config": "",
      "tts": "edgetts",
      "REF_FILE": "zh-CN-YunxiaNeural",
      "REF_TEXT": null,
      "TTS_SERVER": "http://127.0.0.1:9880",
      "transport": "webrtc",
      "push_url": "http://localhost:1985/rtc/v1/whip/?app=live&stream=livestream",
      "max_session": 1,
      "listenport": 8010,
      "customopt": []
    }
  }
}
```

### Configuration fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fps` | int | 25 | Video frame rate |
| `l` | int | 10 | Audio buffer parameter |
| `m` | int | 8 | Audio buffer parameter |
| `r` | int | 10 | Audio buffer parameter |
| `model` | string | "wav2lip" | Avatar model: musetalk / wav2lip / ultralight |
| `avatar_id` | string | "wav2lip256_avatar1" | Default avatar ID |
| `data_path` | string | "data/avatars" | Avatar data directory |
| `batch_size` | int | 16 | Inference batch size |
| `modelres` | int | 192 | Model resolution |
| `modelfile` | string | "" | Custom model file path |
| `customvideo_config` | string | "" | Custom action configuration JSON path |
| `tts` | string | "edgetts" | TTS plugin |
| `REF_FILE` | string | "zh-CN-YunxiaNeural" | TTS reference file or voice model ID |
| `REF_TEXT` | string | null | TTS reference text |
| `TTS_SERVER` | string | "http://127.0.0.1:9880" | TTS server address |
| `transport` | string | "webrtc" | Output transport: rtcpush / webrtc / rtmp / virtualcam |
| `push_url` | string | — | RTCPush destination URL |
| `max_session` | int | 1 | Maximum number of sessions |
| `listenport` | int | 8010 | HTTP listening port |
| `customopt` | array | [] | Parsed custom action configuration |

---

## 2. List active sessions

```http
GET /api/admin/sessions
```

Returns all active sessions with their status and configuration.

**Request parameters:** None.

**Response:**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "sessions": [
      {
        "sessionid": "uuid-string",
        "speaking": true,
        "recording": false,
        "model": "musetalk",
        "avatar_id": "avatar1",
        "REF_FILE": "zh-CN-YunxiaNeural",
        "transport": "webrtc",
        "batch_size": 16,
        "customopt": []
      }
    ]
  }
}
```

### Session fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionid` | string | Unique session ID |
| `speaking` | bool | Whether the session is currently speaking |
| `recording` | bool | Whether the session is currently recording |
| `model` | string | Avatar model used by the session |
| `avatar_id` | string | Avatar ID used by the session |
| `REF_FILE` | string | TTS reference file or model ID |
| `transport` | string | Output transport |
| `batch_size` | int | Inference batch size |
| `customopt` | array | Custom action configuration |
