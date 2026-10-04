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
        fps, count, samples = (20, 24, 19200) if mode == 'soulx' else (25, 2, 1280)
        print(json.dumps({'event': 'ready', 'fps': fps, 'chunk_frames': count,
                          'chunk_samples': samples}), flush=True)
    elif event == 'render':
        if mode == 'hang':
            time.sleep(60)
        if mode == 'crash':
            sys.exit(4)
        n = 1 if mode == 'short' else 24 if mode == 'soulx' else 2
        for i in range(n):
            frame = np.full((32, 32, 3), i * 100 % 256, dtype=np.uint8)
            encoded = base64.b64encode(cv2.imencode('.jpg', frame)[1]).decode()
            print(json.dumps({'event': 'frame', 'seq': msg['seq'], 'jpeg': encoded}), flush=True)
        print(json.dumps({'event': 'done', 'seq': msg['seq']}), flush=True)
    elif event in ('reset', 'start'):
        print(json.dumps({'event': 'reset'}), flush=True)
    elif event == 'close':
        break
