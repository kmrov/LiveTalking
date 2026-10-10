"""CPU protocol fixture; no model weights or GPU."""
import base64
import json
import sys
import time
import cv2
import numpy as np

mode = sys.argv[1] if len(sys.argv) > 1 else ''
for line in sys.stdin:
    msg = json.loads(line)
    event = msg['command']
    if event == 'init':
        fps, count, samples = (20, 24, 19200) if mode in ('soulx', 'soulx_startup') else (25, 5, 3200) if mode == 'avtr1' else (25, 2, 1280)
        ready = {'event': 'ready', 'fps': fps, 'chunk_frames': count, 'chunk_samples': samples}
        if mode == 'avtr1':
            ready['future_samples'] = 3280
        if mode == 'soulx_startup':
            ready.update(startup_frames=8, startup_samples=6400)
        print(json.dumps(ready), flush=True)
    elif event == 'render':
        if mode == 'hang':
            time.sleep(60)
        if mode == 'crash':
            sys.exit(4)
        if mode == 'avtr1':
            assert len(base64.b64decode(msg['future'])) == 3280 * 4
            assert len(base64.b64decode(msg['listen'])) == 6480 * 4
        n = 1 if mode == 'short' else 8 if mode == 'soulx_startup' and len(base64.b64decode(msg['audio'])) == 6400 * 4 else 24 if mode in ('soulx', 'soulx_startup') else 5 if mode == 'avtr1' else 2
        for i in range(n):
            frame = np.full((32, 32, 3), i * 100 % 256, dtype=np.uint8)
            encoded = base64.b64encode(cv2.imencode('.jpg', frame)[1]).decode()
            print(json.dumps({'event': 'frame', 'seq': msg['seq'], 'jpeg': encoded}), flush=True)
        print(json.dumps({'event': 'done', 'seq': msg['seq']}), flush=True)
    elif event in ('reset', 'start'):
        print(json.dumps({'event': 'reset'}), flush=True)
    elif event == 'close':
        break
