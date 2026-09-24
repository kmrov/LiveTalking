# LiveTalking API Reference

Base URL: `http://<host>:<listenport>`

All general API endpoints return responses in this format:

```json
{ "code": 0, "msg": "ok", "data": {} }
```

A `code` of 0 means success; a nonzero value means an error.

---

## 1. WebRTC offer (JSON)

Exchange SDP to establish a WebRTC connection. Pass optional parameters in the JSON body.

```http
POST /offer
```

**Content-Type:** `application/json`

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `sdp` | Yes | string | — | WebRTC offer SDP |
| `type` | Yes | string | — | Must be `offer` |
| `avatar` | No | string | Startup option | Avatar ID |
| `refaudio` | No | string | — | Reference audio |
| `reftext` | No | string | — | Reference text |
| `custom_config` | No | string | — | Custom action configuration as a JSON string |

**Response (200):**

```json
{
  "sdp": "v=0\r\n...",
  "type": "answer",
  "sessionid": "session-uuid"
}
```

---

## 2. WebRTC offer (WHEP)

Uses the [WHEP protocol](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/) (WebRTC HTTP Egress Protocol). Send the SDP offer as raw `application/sdp` text and pass optional parameters in the query string.

```http
POST /whep
```

**Content-Type:** `application/sdp`

**Query parameters:**

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `avatar` | No | string | Startup option | Avatar ID |
| `refaudio` | No | string | — | Reference audio |
| `reftext` | No | string | — | Reference text |
| `tts` | No | string | — | TTS engine |
| `tts_server` | No | string | — | TTS server address |
| `tts_speed` | No | number | — | TTS speech speed |
| `custom_config` | No | string | — | Custom action configuration as a JSON string |

**Body:** Raw SDP offer, for example:

```text
v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n...
```

**Response (201):**

- `Content-Type`: `application/sdp`
- `X-Session-ID`: generated session ID (UUID)

The response body contains the raw SDP answer:

```text
v=0\r\no=- ...\r\n...
```

**Client example:**

```javascript
const params = new URLSearchParams({
  avatar: 'wav2lip256_avatar1',
  refaudio: 'zh-CN-YunxiaNeural',
});

const res = await fetch('/whep?' + params.toString(), {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: pc.localDescription.sdp,
});

const answerSdp = await res.text();
const sessionid = res.headers.get('X-Session-ID');
await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
```

---

## 3. Send text (Human)

Send text for the avatar to speak. Use direct echo or LLM chat mode.

```http
POST /human
```

**Content-Type:** `application/json`

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `sessionid` | Yes | string | — | Session ID |
| `text` | Yes | string | — | Input text |
| `type` | Yes | string | — | `echo`: repeat the text; `chat`: generate an LLM response |
| `interrupt` | No | bool | false | Interrupt speech already in progress |
| `tts` | No | object | — | TTS settings passed through to the engine, such as `voice` or `emotion` |

**Response:**

```json
{ "code": 0, "msg": "ok" }
```

---

## 4. Send audio (Human Audio)

Upload an audio file to drive the avatar.

```http
POST /humanaudio
```

**Content-Type:** `multipart/form-data`

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `sessionid` | Yes | string | Session ID |
| `file` | Yes | file | Audio file |

**Response:**

```json
{ "code": 0, "msg": "ok" }
```

---

## 5. Interrupt speech

Immediately clear the current session's audio queue.

```http
POST /interrupt_talk
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `sessionid` | Yes | string | Session ID |

**Response:**

```json
{ "code": 0, "msg": "ok" }
```

---

## 6. Check speaking status

```http
POST /is_speaking
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `sessionid` | Yes | string | Session ID |

**Response:**

```json
{
  "code": 0,
  "msg": "ok",
  "data": true
}
```

---

## 7. Control recording

Start or stop a recording rendered on the server.

```http
POST /record
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `sessionid` | Yes | string | Session ID |
| `type` | Yes | string | `start_record`: start recording; `end_record`: stop and assemble the recording |

**Response:**

```json
{ "code": 0, "msg": "ok" }
```

---

## 8. Download a recording

Download a completed MP4 recording.

```http
GET /record/{sessionid}
```

**Path parameter:** `sessionid` — session ID.

**Response:** MP4 file stream, or 404 if the file does not exist.

---

## 9. Set action state (Audiotype)

```http
POST /set_audiotype
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `sessionid` | Yes | string | Session ID |
| `audiotype` | Yes | int | Index of a predefined action or state |

**Response:**

```json
{ "code": 0, "msg": "ok" }
```

---

## 10. SSE event stream

```http
GET /sse?sessionid=<sessionid>
```

**Protocol:** Server-Sent Events (SSE)

Receive asynchronous server-to-client status updates, such as speech events and state changes.

**Query parameters:**

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `sessionid` | Yes | string | Session ID |

**Response format:** `Content-Type: text/event-stream`

Each event is a line of JSON:

```text
data: {"status": "start"}

```

**Client example:**

```javascript
const es = new EventSource(`/sse?sessionid=${sessionid}`);
es.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // data contains a speech event or status update from the server
};
es.onerror = () => {
    // EventSource reconnects automatically after a network or server disconnect
};

// Close the connection when it is no longer needed
es.close();
```
