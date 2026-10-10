"""Generation-tagged PCM queue; interruption invalidates all older audio."""
from dataclasses import dataclass, field
import queue
import threading
import time
import numpy as np


@dataclass
class Packet:
    data: np.ndarray
    type: int = 0
    userdata: dict = field(default_factory=dict)
    position: int = -1


def silence():
    return Packet(np.zeros(320, np.float32), 1)


class AudioBuffer:
    def __init__(self, playback=True):
        self.queue = queue.Queue(maxsize=1500)
        self.playback = queue.Queue(maxsize=1500) if playback else None
        self.lock = threading.RLock()
        self.generation = 0
        self.next_position = 0
        self._collecting_generation = None
        self.closed = threading.Event()

    def put_audio_frame(self, audio_chunk, datainfo, valid=None):
        data = np.asarray(audio_chunk, dtype=np.float32)
        if data.shape != (320,) or not np.isfinite(data).all():
            raise ValueError('Expected 320 finite PCM samples at 16 kHz.')
        with self.lock:
            generation = self.generation
        while not self.closed.is_set():
            with self.lock:
                if generation != self.generation or (valid is not None and not valid()):
                    return
                if self.queue.full() or (self.playback is not None and self.playback.full()):
                    pass
                else:
                    packet = Packet(data.copy(), 0, dict(datainfo), self.next_position)
                    self.queue.put_nowait((generation, packet))
                    if self.playback is not None:
                        self.playback.put_nowait((generation, packet))
                    self.next_position += 320
                    return
            self.closed.wait(.02)

    def pop_playback(self):
        if self.playback is None:
            return None
        try:
            return self.playback.get_nowait()
        except queue.Empty:
            return None

    def peek_playback(self):
        if self.playback is None:
            return None
        with self.playback.mutex:
            return self.playback.queue[0] if self.playback.queue else None

    def flush_talk(self):
        with self.lock:
            self.generation += 1
            self.next_position = 0
            while True:
                try:
                    self.queue.get_nowait()
                except queue.Empty:
                    break
            if self.playback is not None:
                while True:
                    try:
                        self.playback.get_nowait()
                    except queue.Empty:
                        break

    @property
    def collecting(self):
        return self._collecting_generation == self.generation

    def take(self, count, quit_event, gap_timeout=.15):
        try:
            generation, first = self.queue.get(timeout=.05)
        except queue.Empty:
            return None
        self._collecting_generation = generation
        try:
            packets = [first]
            while len(packets) < count and not quit_event.is_set():
                if generation != self.generation:
                    return None
                if packets[-1].userdata.get('status') == 'end':
                    break
                try:
                    next_generation, packet = self.queue.get(timeout=.05 if gap_timeout is None else gap_timeout)
                except queue.Empty:
                    if gap_timeout is None:
                        continue
                    break
                if next_generation != generation:
                    # Interruption arrived while waiting; this packet starts the new batch.
                    generation, packets = next_generation, [packet]
                    self._collecting_generation = generation
                else:
                    packets.append(packet)
            if generation != self.generation or quit_event.is_set():
                return None
            packets.extend(silence() for _ in range(count - len(packets)))
            return generation, packets
        finally:
            self._collecting_generation = None

    def peek_future(self, sample_count, generation, quit_event):
        """Wait for the model's lookahead without removing playback packets."""
        while not quit_event.is_set() and not self.closed.is_set():
            if generation != self.generation:
                return None
            parts = []
            ended = False
            with self.queue.mutex:
                for packet_generation, packet in self.queue.queue:
                    if packet_generation != generation:
                        break
                    parts.append(packet.data)
                    if packet.userdata.get('status') == 'end':
                        ended = True
                        break
                    if sum(len(part) for part in parts) >= sample_count:
                        break
            available = sum(len(part) for part in parts)
            if available >= sample_count or ended:
                result = np.zeros(sample_count, np.float32)
                if available:
                    audio = np.concatenate(parts)
                    result[:min(available, sample_count)] = audio[:sample_count]
                return result
            quit_event.wait(.02)
        return None

    def close(self):
        self.closed.set()
        self.flush_talk()


class ListeningAudio:
    """Latest microphone PCM for AVTR-1; old input is dropped if inference lags."""
    def __init__(self, max_samples=32000, block_samples=3200):
        self.lock = threading.Lock()
        self.max_samples = max_samples
        self.block_samples = block_samples
        self.audio = np.zeros(0, np.float32)
        self.received = 0
        self.rendered = 0
        self.snapshot_received = 0

    def push(self, pcm):
        pcm = np.asarray(pcm, dtype=np.float32)
        if pcm.ndim != 1 or not 0 < len(pcm) <= 16000 or not np.isfinite(pcm).all():
            raise ValueError('Expected finite mono microphone PCM at 16 kHz.')
        with self.lock:
            self.audio = np.concatenate((self.audio, pcm))[-self.max_samples:]
            self.received += len(pcm)

    def has_block(self):
        with self.lock:
            return self.received - self.rendered >= self.block_samples

    def snapshot(self, sample_count):
        with self.lock:
            result = np.zeros(sample_count, np.float32)
            if self.received > self.rendered:
                count = min(sample_count, len(self.audio))
                result[-count:] = self.audio[-count:]
            self.snapshot_received = self.received
            return result

    def mark_rendered(self):
        with self.lock:
            self.rendered = self.snapshot_received
