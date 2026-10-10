"""Bounded JSON-line subprocess protocol for isolated inference engines."""
import base64
import json
from pathlib import Path
import queue
import subprocess
import threading
import time

import cv2
import numpy as np

MAX_LINE = 24 * 1024 * 1024


class WorkerClient:
    def __init__(self, command, *, source, cwd=None, timeout=300, expected_fps=None):
        self.timeout = timeout
        self.closed = threading.Event()
        self._close_lock = threading.Lock()
        self.messages = queue.Queue(maxsize=4)
        self.sequence = 0
        self.process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, bufsize=0)
        self.reader = threading.Thread(target=self._read, daemon=True, name='avatar-worker-reader')
        self.reader.start()
        try:
            self._send({'command': 'init', 'source': str(source)})
            ready = self._receive()
            if (ready.get('event') != 'ready' or type(ready.get('fps')) is not int
                    or ready['fps'] not in (20, 25) or (expected_fps is not None and ready['fps'] != expected_fps)
                    or type(ready.get('chunk_frames')) is not int or not 1 <= ready['chunk_frames'] <= 100
                    or type(ready.get('chunk_samples')) is not int
                    or ready['chunk_samples'] != ready['chunk_frames'] * 16000 // ready['fps']):
                raise RuntimeError('Invalid avatar worker ready response.')
            startup_frames = ready.get('startup_frames', 0)
            startup_samples = ready.get('startup_samples', 0)
            if (type(startup_frames) is not int or type(startup_samples) is not int
                    or not 0 <= startup_frames < ready['chunk_frames']
                    or startup_samples != startup_frames * 16000 // ready['fps']):
                raise RuntimeError('Invalid avatar startup block.')
            self.fps = ready['fps']
            self.chunk_frames = ready['chunk_frames']
            self.chunk_samples = ready['chunk_samples']
            self.startup_frames = startup_frames
            self.startup_samples = startup_samples
            future_samples = ready.get('future_samples', 0)
            if type(future_samples) is not int or not 0 <= future_samples <= 32000:
                raise RuntimeError('Invalid avatar lookahead length.')
            self.future_samples = future_samples
        except BaseException:
            self.close()
            raise

    def _enqueue(self, value):
        while not self.closed.is_set():
            try:
                self.messages.put(value, timeout=0.1)
                return
            except queue.Full:
                pass

    def _read(self):
        stream = None
        try:
            # BufferedReader avoids one syscall per byte for JPEG messages.
            import io
            stream = io.BufferedReader(self.process.stdout)
            while not self.closed.is_set():
                line = stream.readline(MAX_LINE + 1)
                if not line:
                    raise RuntimeError('Avatar worker exited before completing its response.')
                if len(line) > MAX_LINE:
                    raise RuntimeError('Avatar worker response is too large.')
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise RuntimeError('Invalid avatar worker response.')
                self._enqueue(value)
        except Exception as error:
            self._enqueue(RuntimeError(str(error)))
        finally:
            if stream is not None:
                stream.close()

    def _send(self, value):
        if self.closed.is_set():
            raise RuntimeError('Avatar worker is closed.')
        try:
            data = (json.dumps(value) + '\n').encode()
            # FileIO can perform short writes.
            view = memoryview(data)
            while view:
                n = self.process.stdin.write(view)
                if not n:
                    raise BrokenPipeError()
                view = view[n:]
        except (OSError, ValueError) as error:
            raise RuntimeError('Avatar worker input closed.') from error

    def _receive(self):
        deadline = time.monotonic() + self.timeout
        while not self.closed.is_set():
            try:
                value = self.messages.get(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
                if isinstance(value, Exception):
                    raise value
                if value.get('event') == 'error':
                    raise RuntimeError('Avatar inference failed: ' + str(value.get('message', 'unknown error')))
                return value
            except queue.Empty:
                if time.monotonic() >= deadline:
                    self.close()
                    raise RuntimeError('Avatar worker response timed out.')
        raise RuntimeError('Avatar worker is closed.')

    def render(self, audio, *, future=None, listen=None):
        audio = np.asarray(audio, dtype='<f4')
        expected_frames = self.startup_frames if self.startup_frames and audio.shape == (self.startup_samples,) else self.chunk_frames
        if audio.shape != (expected_frames * 16000 // self.fps,) or not np.isfinite(audio).all():
            raise ValueError('Invalid audio chunk length or non-finite audio samples.')
        if self.future_samples:
            future = np.zeros(self.future_samples, dtype='<f4') if future is None else np.asarray(future, dtype='<f4')
            listen = np.zeros(audio.size + self.future_samples, dtype='<f4') if listen is None else np.asarray(listen, dtype='<f4')
            if (future.shape != (self.future_samples,) or listen.shape != (audio.size + self.future_samples,)
                    or not np.isfinite(future).all() or not np.isfinite(listen).all()):
                raise ValueError('Invalid avatar lookahead or listening audio.')
        elif future is not None or listen is not None:
            raise ValueError('This avatar does not accept lookahead or listening audio.')
        self.sequence += 1
        seq = self.sequence
        request = {'command': 'render', 'seq': seq, 'audio': base64.b64encode(audio.tobytes()).decode('ascii')}
        if self.future_samples:
            request['future'] = base64.b64encode(future.tobytes()).decode('ascii')
            request['listen'] = base64.b64encode(listen.tobytes()).decode('ascii')
        self._send(request)
        count = 0
        while True:
            value = self._receive()
            if value.get('seq') != seq:
                raise RuntimeError('Avatar worker returned an unexpected sequence.')
            if value.get('event') == 'done':
                if count != expected_frames:
                    raise RuntimeError(f'Avatar worker returned {count} frames, expected {expected_frames}.')
                return
            if value.get('event') != 'frame' or count >= expected_frames:
                raise RuntimeError('Unexpected avatar worker frame response.')
            try:
                encoded = base64.b64decode(value['jpeg'], validate=True)
                frame = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None or max(frame.shape[:2]) > 4096:
                    raise ValueError('Invalid frame dimensions.')
            except (ValueError, KeyError, TypeError) as error:
                raise RuntimeError('Invalid avatar worker JPEG frame.') from error
            count += 1
            yield frame

    def reset(self):
        self._send({'command': 'reset'})
        if self._receive().get('event') != 'reset':
            raise RuntimeError('Avatar worker did not reset.')

    def close(self):
        # A second owner must wait until the first owner has actually reaped it.
        with self._close_lock:
            self._close()

    def _close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        for stream in (self.process.stdin, self.process.stdout):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        if threading.current_thread() is not self.reader:
            self.reader.join(timeout=1)


def open_worker(config, source):
    script = Path(__file__).resolve().parents[2] / 'scripts/generative_avatar_worker.py'
    command = [config['python'], '-u', str(script), '--root', config['checkout'], '--model', config['model']]
    return WorkerClient(command, cwd=config['root'], source=source,
                        timeout=float(config.get('timeout', 300)),
                        expected_fps=20 if config['model'] == 'soulx' else 25)
