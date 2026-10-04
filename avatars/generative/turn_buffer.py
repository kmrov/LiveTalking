"""Disk-backed utterance frames with exact PCM and JSON event metadata.

The buffer owns its anonymous temporary file; no external file is accepted.
Only one encoded frame is held while appending or replaying. Closing also
releases the file after cancellation, without keeping a whole turn in RAM.
"""
import json
import math
import struct
import tempfile
import threading

import cv2
import numpy as np

from .audio_buffer import Packet

_HEADER = struct.Struct('>4sIIII')  # magic, JPEG bytes, JSON bytes, width, height
_MAGIC = b'GTB1'
_MAX_JPEG = 24 * 1024 * 1024
_MAX_JSON = 64 * 1024
_PCM_BYTES = 2 * 320 * 4


def _json_value(value):
    if value is None or type(value) in (bool, int, str):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        for child in value:
            _json_value(child)
        return
    if type(value) is dict and all(type(key) is str for key in value):
        for child in value.values():
            _json_value(child)
        return
    raise ValueError('Turn packet metadata must contain only finite JSON values.')


class TurnBuffer:
    def __init__(self, *, max_bytes=512 * 1024 * 1024):
        if type(max_bytes) is not int or max_bytes <= 0:
            raise ValueError('Turn buffer limit must be a positive integer.')
        self._limit = max_bytes
        self._file = tempfile.TemporaryFile(mode='w+b', buffering=0)
        self._lock = threading.Lock()
        self._frames = 0
        self._bytes = 0

    @property
    def frames(self):
        return self._frames

    def _open(self):
        if self._file.closed:
            raise ValueError('Turn buffer is closed.')

    def append(self, frame, packets):
        self._open()
        if (not isinstance(frame, np.ndarray) or frame.dtype != np.uint8
                or frame.ndim != 3 or frame.shape[2] != 3
                or not 0 < min(frame.shape[:2]) <= max(frame.shape[:2]) <= 4096):
            raise ValueError('Turn frame must be BGR uint8 with dimensions from 1 to 4096.')
        if not isinstance(packets, list) or len(packets) != 2:
            raise ValueError('Exactly two audio packets are required per turn frame.')
        metadata, audio = [], []
        for packet in packets:
            if (not isinstance(packet, Packet) or type(packet.type) is not int
                    or packet.type not in (0, 1) or not isinstance(packet.userdata, dict)):
                raise ValueError('Invalid turn packet type or metadata.')
            _json_value(packet.userdata)
            samples = np.asarray(packet.data)
            if (samples.shape != (320,) or samples.dtype.kind != 'f'
                    or samples.dtype.itemsize != 4 or not np.isfinite(samples).all()):
                raise ValueError('Turn audio requires 320 finite float32 samples per packet.')
            audio.append(samples.astype('<f4', copy=False).tobytes())
            metadata.append({'type': packet.type, 'userdata': packet.userdata})
        encoded_metadata = json.dumps(metadata, ensure_ascii=False, allow_nan=False,
                                      separators=(',', ':')).encode('utf8')
        if len(encoded_metadata) > _MAX_JSON:
            raise ValueError('Turn packet metadata exceeds the size limit.')
        ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok or not 0 < encoded.size <= _MAX_JPEG:
            raise ValueError('Turn JPEG exceeds the size limit or could not be encoded.')
        height, width = frame.shape[:2]
        header = _HEADER.pack(_MAGIC, encoded.size, len(encoded_metadata), width, height)
        size = len(header) + encoded.size + len(encoded_metadata) + _PCM_BYTES
        with self._lock:
            self._open()
            if self._bytes + size > self._limit:
                raise ValueError('Turn buffer disk size limit exceeded.')
            self._file.seek(self._bytes)
            try:
                for part in (header, encoded.tobytes(), encoded_metadata, *audio):
                    remaining = memoryview(part)
                    while remaining:
                        written = self._file.write(remaining)
                        if not written:
                            raise OSError('Could not write turn buffer.')
                        remaining = remaining[written:]
            except BaseException:
                self._file.truncate(self._bytes)
                raise
            self._bytes += size
            self._frames += 1

    def _read(self, size):
        data = self._file.read(size)
        if len(data) != size:
            raise ValueError('Truncated turn buffer record.')
        return data

    def replay(self):
        with self._lock:
            self._open()
            count, end = self._frames, self._bytes
        position = 0
        for _ in range(count):
            with self._lock:
                self._open()
                self._file.seek(position)
                magic, jpeg_size, json_size, width, height = _HEADER.unpack(self._read(_HEADER.size))
                if (magic != _MAGIC or not 0 < jpeg_size <= _MAX_JPEG
                        or not 0 < json_size <= _MAX_JSON
                        or not 0 < width <= 4096 or not 0 < height <= 4096
                        or position + _HEADER.size + jpeg_size + json_size + _PCM_BYTES > end):
                    raise ValueError('Malformed turn buffer header.')
                jpeg = self._read(jpeg_size)
                raw_metadata = self._read(json_size)
                pcm = self._read(_PCM_BYTES)
                position = self._file.tell()
            try:
                metadata = json.loads(raw_metadata)
                _json_value(metadata)
                if (not isinstance(metadata, list) or len(metadata) != 2
                        or any(not isinstance(item, dict) or set(item) != {'type', 'userdata'}
                               or type(item['type']) is not int or item['type'] not in (0, 1)
                               or not isinstance(item['userdata'], dict) for item in metadata)):
                    raise ValueError('Invalid packet metadata.')
                frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
                if frame is None or frame.shape != (height, width, 3):
                    raise ValueError('Invalid JPEG dimensions.')
                samples = np.frombuffer(pcm, dtype='<f4').reshape(2, 320)
                if not np.isfinite(samples).all():
                    raise ValueError('Invalid audio samples.')
            except (ValueError, TypeError, KeyError, cv2.error) as error:
                raise ValueError('Malformed turn buffer record.') from error
            yield frame, [Packet(samples[i].copy(), item['type'], item['userdata'])
                          for i, item in enumerate(metadata)]
        if position != end:
            raise ValueError('Malformed turn buffer record count.')

    def close(self):
        with self._lock:
            self._file.close()
