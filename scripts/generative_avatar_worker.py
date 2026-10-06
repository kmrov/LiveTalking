"""Persistent model process. Stdout is reserved for the frame protocol."""
import argparse
import base64
import contextlib
import ctypes
import importlib
import json
import os
from pathlib import Path
import signal
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.generative_runtime import load_runtime


def parent_death_signal():
    if sys.platform == 'linux':
        parent = os.getppid()
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)
        if os.getppid() != parent or parent == 1:
            raise SystemExit('Avatar parent process exited.')


def serve(engine, input_stream, output_stream):
    import cv2
    import numpy as np
    def emit(value):
        output_stream.write(json.dumps(value) + '\n')
        output_stream.flush()
    try:
        for line in input_stream:
            if len(line) > 2 * 1024 * 1024:
                raise ValueError('Avatar command too large.')
            msg = json.loads(line)
            command = msg['command']
            if command == 'init':
                engine.start(msg['source'])
                ready = {'event': 'ready', 'fps': engine.fps, 'chunk_frames': engine.chunk_frames,
                         'chunk_samples': engine.chunk_frames * 16000 // engine.fps}
                if getattr(engine, 'startup_frames', 0):
                    ready['startup_frames'] = engine.startup_frames
                    ready['startup_samples'] = engine.startup_frames * 16000 // engine.fps
                emit(ready)
            elif command == 'reset':
                engine.reset()
                emit({'event': 'reset'})
            elif command == 'render':
                audio = np.frombuffer(base64.b64decode(msg['audio'], validate=True), dtype='<f4').copy()
                startup_frames = getattr(engine, 'startup_frames', 0)
                expected_frames = startup_frames if startup_frames and audio.size == startup_frames * 16000 // engine.fps else engine.chunk_frames
                if audio.shape != (expected_frames * 16000 // engine.fps,) or not np.isfinite(audio).all():
                    raise ValueError('Invalid engine audio chunk.')
                count = 0
                for frame in engine.render(audio):
                    frame = np.asarray(frame)
                    if frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8 or max(frame.shape[:2]) > 4096:
                        raise ValueError('Engine must produce RGB uint8 frames up to 4096 pixels.')
                    if count >= expected_frames:
                        raise ValueError('Engine produced too many frames.')
                    ok, jpeg = cv2.imencode('.jpg', cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
                    if not ok:
                        raise ValueError('Could not encode engine frame.')
                    emit({'event': 'frame', 'seq': msg['seq'], 'jpeg': base64.b64encode(jpeg).decode('ascii')})
                    count += 1
                if count != expected_frames:
                    raise ValueError(f'Engine returned {count} frames instead of {expected_frames}.')
                emit({'event': 'done', 'seq': msg['seq']})
            elif command == 'close':
                break
            else:
                raise ValueError('Unknown avatar worker command.')
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({'event': 'error', 'message': str(error)})
        return 1
    finally:
        engine.close()
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--model', choices=['ditto', 'soulx'], required=True)
    args = parser.parse_args()
    parent_death_signal()
    protocol = sys.stdout
    # Redirect the OS descriptor too: native libraries sometimes print directly.
    protocol_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    protocol = os.fdopen(protocol_fd, 'w', buffering=1)
    with contextlib.redirect_stdout(sys.stderr):
        try:
            config = load_runtime(args.root, args.model)
            os.chdir(config['root'])
            sys.path.insert(0, config['root'])
            module = importlib.import_module(f'avatars.generative.{args.model}_engine')
            engine = module.Engine(config)
        except Exception as error:
            import traceback
            traceback.print_exc(file=sys.stderr)
            protocol.write(json.dumps({'event': 'error', 'message': str(error)}) + '\n')
            protocol.flush()
            return 1
        return serve(engine, sys.stdin, protocol)


if __name__ == '__main__':
    raise SystemExit(main())
