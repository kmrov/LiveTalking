# Avatar Generation API Reference

Base URL: `http://<host>:<listenport>`

---

## 1. Create an avatar generation task

```http
POST /api/avatar/task
```

**Content-Type:** `application/json`, or `multipart/form-data` when uploading a file.

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `model` | Yes | string | — | Model type: `wav2lip` / `musetalk` |
| `avatar_id` | Yes | string | — | Unique avatar ID |
| `video_file` | No | file | — | Video upload (multipart), saved in `./data/tmp/` |
| `video_path` | Conditional | string | — | Local video path; required when `video_file` is not uploaded |
| `img_size` | No | int | 256 | Output image size |
| `nosmooth` | No | bool | false | Disable face detection smoothing |
| `bbox_shift` | No | int | 0 | Face bounding box shift (MuseTalk) |
| `extra_margin` | No | int | 10 | Extra face crop margin (MuseTalk) |
| `pads` | No | string | "0 10 0 0" | Padding: top bottom left right, separated by spaces |
| `parsing_mode` | No | string | "jaw" | Face parsing mode (MuseTalk) |
| `version` | No | string | "v15" | MuseTalk version: `v1` / `v15` |
| `face_det_batch_size` | No | int | 16 | Face detection batch size (Wav2Lip) |
| `task_id` | No | string | Generated UUID | Custom task ID |
| `notifyurl` | No | string | — | Callback URL; receives a POST when task status changes |

**Response:**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "task_id": "uuid-string"
  }
}
```

---

## 2. Get task status

```http
GET /api/avatar/task/{task_id}
```

**Path parameter:** `task_id` — ID returned when the task was created.

**Response:**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "task_id": "uuid-string",
    "model_type": "musetalk",
    "avatar_id": "avatar1",
    "status": "running",
    "progress": 45,
    "error_msg": "",
    "notify_url": "",
    "start_time": 1713916800.0,
    "end_time": null,
    "duration": 30.5
  }
}
```

`status` values: `pending` → `running` → `completed` / `failed`.

`progress`: integer from 0 to 100.

---

## 3. List all tasks

```http
GET /api/avatar/tasks
```

**Response:**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "tasks": [
      { "task_id": "...", "status": "completed", "progress": 100 },
      { "task_id": "...", "status": "running", "progress": 30 }
    ]
  }
}
```

Tasks are sorted by `start_time` in descending order.

---

## 4. Delete a task

```http
DELETE /api/avatar/task/{task_id}
```

**Path parameter:** `task_id`.

**Responses:**

```jsonc
// Success
{ "code": 0, "msg": "ok", "data": { "msg": "Task deleted" } }

// Failure: task does not exist
{ "code": -1, "msg": "Task not found" }

// Failure: task cannot be deleted
{ "code": -1, "msg": "Task is in running state, cannot delete" }
```

Only tasks in the `pending` state can be deleted.

---

## Model-specific parameters

| Model | Parameters | Generation module |
|-------|------------|-------------------|
| `wav2lip` | `face_det_batch_size`, `pads`, `nosmooth`, `img_size` | `avatars/wav2lip/genavatar.py` |
| `musetalk` | `bbox_shift`, `extra_margin`, `parsing_mode`, `version` | `avatars/musetalk/genavatar.py` |

## Generated output

Avatar data is saved under `<data_path>/<avatar_id>/`. It contains `full_imgs/`, `face_imgs/`, `coords.pkl`, and model-specific files. After generation, start the server with `--avatar_id <avatar_id>` to use it.
