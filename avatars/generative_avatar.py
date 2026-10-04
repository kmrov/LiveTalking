"""Ditto/SoulX sessions with isolated models and synchronized existing outputs."""
import json
from pathlib import Path
import queue
import re
import threading
import time

import cv2
import numpy as np

from avatars.base_avatar import BaseAvatar
from avatars.generative.audio_buffer import AudioBuffer, silence
from avatars.generative.worker_client import open_worker
from avatars.generative.turn_buffer import TurnBuffer
from registry import register
from server.generative_runtime import load_runtime
from utils.logger import logger


def load_avatar(avatar_id):
    if not isinstance(avatar_id, str) or not re.fullmatch(r'[\w-]{1,128}', avatar_id):
        raise ValueError('Invalid avatar ID.')
    base = Path('data/avatars').resolve()
    folder = base / avatar_id
    source = (folder / 'full_imgs/00000000.png').resolve(strict=True)
    if not source.is_relative_to(base):
        raise ValueError('Avatar reference is outside the library.')
    marker = json.loads((folder / 'generative-avatar.json').read_text())
    if marker.get('version') != 1 or marker.get('model') not in ('ditto', 'soulx'):
        raise ValueError('Invalid generative avatar marker.')
    frame = cv2.imread(str(source))
    if frame is None:
        raise ValueError('Could not read avatar reference image.')
    return {'source': str(source), 'frame': frame, 'model': marker['model']}


class ModelRuntime:
    def __init__(self, config, source):
        self.config = config
        self.lock = threading.Lock()
        self.source = source
        self.client = open_worker(config, source)
        self.leased = False

    def acquire(self, source):
        with self.lock:
            if self.leased:
                raise RuntimeError('Generative avatars support one active session.')
            if self.client is None or self.client.closed.is_set() or self.client.process.poll() is not None or source != self.source:
                if self.client is not None:
                    self.client.close()
                self.client = open_worker(self.config, source)
                self.source = source
            self.leased = True
            return self.client

    def release(self, client):
        with self.lock:
            client.close()
            if self.client is client:
                self.client = None
                self.leased = False

    def close(self):
        with self.lock:
            if self.client:
                self.client.close()
                self.client = None
            self.leased = False


def load_model(opt):
    if opt.fps != 25 or opt.max_session != 1:
        raise ValueError('Ditto/SoulX require 25 fps audio/output clock and --max_session 1.')
    config = load_runtime(Path.cwd(), opt.model)
    avatar = load_avatar(opt.avatar_id)
    if avatar['model'] != opt.model:
        raise ValueError('Avatar was prepared for a different engine.')
    logger.info('Loading %s isolated engine', opt.model)
    return ModelRuntime(config, avatar['source'])


def warm_up(*args):
    # ModelRuntime initialization already loads the model and reference.
    pass


@register('avatar', 'ditto')
@register('avatar', 'soulx')
class GenerativeAvatar(BaseAvatar):
    def __init__(self, opt, model, avatar):
        if avatar['model'] != model.config['model']:
            raise ValueError('Reference belongs to a different generative engine.')
        super().__init__(opt)
        self.model_runtime = model
        self.worker = model.acquire(avatar['source'])
        self.frame_list_cycle = [avatar['frame']]
        self.height, self.width = avatar['frame'].shape[:2]
        self._display_frame = avatar['frame']
        self._target_frame = avatar['frame']
        self._fade_origin = avatar['frame']
        self._fade_steps = min(6, self.worker.chunk_frames)
        self._fade_remaining = 0
        self._seen_generated = False
        self.buffered_playback = bool(model.config.get('buffered_playback', True))
        self.asr = AudioBuffer(playback=not self.buffered_playback)
        self.generated = queue.Queue(maxsize=self.worker.chunk_frames)
        self.render_error = None
        self.inference_active = False
        self.pending_buffer = False
        self.shutdown_event = threading.Event()

    def clear_speech(self):
        # One lock covers epoch invalidation and publication, preventing stale frames.
        with self.asr.lock:
            super().clear_speech()
            while True:
                try:
                    self.generated.get_nowait()
                except queue.Empty:
                    break
            player = getattr(self.output, '_player', None)
            if player is not None and hasattr(player, 'clear_buffers'):
                player.clear_buffers()
            self._fade_origin = self._display_frame
            self._target_frame = self._display_frame
            self._fade_remaining = self._fade_steps if self._seen_generated else 0
            self.speaking = False

    def put_tts_audio_frame(self, audio, event, producer, generation):
        # The producer's epoch crosses the scheduling boundary with the packet.
        # flush_talk changes that epoch under this same delivery lock.
        self.asr.put_audio_frame(audio, event, valid=lambda: producer._generation == generation)

    def is_speaking(self):
        return (self.speaking or self.inference_active or self.pending_buffer or self.asr.collecting
                or not self.asr.queue.empty() or not self.generated.empty()
                or (self.asr.playback is not None and not self.asr.playback.empty()))

    def _enqueue_frame(self, item, quit_event):
        while not quit_event.is_set() and item[0] == self.asr.generation:
            try:
                self.generated.put(item, timeout=.05)
                return
            except queue.Full:
                pass

    def _generate(self, quit_event):
        generation = 0
        reset_before_next = False
        buffered = None
        last_input = time.monotonic()
        def play_buffer():
            nonlocal buffered
            if buffered is not None:
                try:
                    for frame, packets in buffered.replay():
                        if quit_event.is_set() or generation != self.asr.generation:
                            break
                        self._enqueue_frame((generation, frame, packets), quit_event)
                finally:
                    buffered.close()
                    buffered = None
                    self.pending_buffer = False
        try:
            while not quit_event.is_set():
                batch = self.asr.take(self.worker.chunk_samples // 320, quit_event,
                                      gap_timeout=.5 if self.buffered_playback else None)
                if batch is None:
                    process = getattr(self.worker, 'process', None)
                    if process is not None and process.poll() is not None:
                        raise RuntimeError('Avatar worker exited while idle.')
                    if buffered is not None and time.monotonic() - last_input >= .5:
                        play_buffer()
                        reset_before_next = True
                    continue
                current, packets = batch
                if current != generation or reset_before_next:
                    if buffered is not None:
                        buffered.close()
                        buffered = None
                        self.pending_buffer = False
                    self.worker.reset()
                    generation = current
                if current != self.asr.generation:
                    continue
                self.inference_active = True
                if self.buffered_playback and buffered is None:
                    buffered = TurnBuffer()
                    self.pending_buffer = True
                audio = np.concatenate([packet.data for packet in packets])
                frame_samples = 16000 // self.worker.fps
                real_samples = sum(packet.type == 0 for packet in packets) * 320
                first_position = packets[0].position
                started = time.monotonic()
                for i, frame in enumerate(self.worker.render(audio)):
                    if current != self.asr.generation or quit_event.is_set():
                        # Consume the complete response before issuing reset.
                        continue
                    if buffered is not None:
                        # Disk replay uses two 20 ms PCM packets per 25 fps
                        # output frame. At SoulX's 20 fps, repeat every fourth
                        # generated frame so all input audio is preserved.
                        first_tick = (i * 25 + self.worker.fps - 1) // self.worker.fps
                        next_tick = ((i + 1) * 25 + self.worker.fps - 1) // self.worker.fps
                        for tick in range(first_tick, next_tick):
                            output_packets = packets[2*tick:2*tick+2]
                            if len(output_packets) == 2 and any(packet.type == 0 for packet in output_packets):
                                buffered.append(frame, output_packets)
                    else:
                        if i * frame_samples >= real_samples:
                            # The model still needs a full chunk, but playback
                            # must not add its synthetic tail to the phrase.
                            continue
                        self._enqueue_frame((current, frame, [], first_position + i * frame_samples), quit_event)
                last_input = time.monotonic()
                ended = any(packet.userdata.get('status') == 'end' for packet in packets)
                reset_before_next = ended if self.buffered_playback else False
                if ended:
                    play_buffer()
                logger.info('%s rendered %s frames in %.3fs', self.opt.model,
                            self.worker.chunk_frames, time.monotonic() - started)
                self.inference_active = False
        except Exception as error:
            if not quit_event.is_set():
                self.render_error = str(error)
                logger.exception('Generative avatar inference failed')
                self.notify({'status': 'error', 'message': self.render_error})
                quit_event.set()
        finally:
            self.inference_active = False
            if buffered is not None:
                buffered.close()
            self.pending_buffer = False

    def _publish_video(self, frame, generated=False):
        if generated:
            if frame.shape[:2] != (self.height, self.width):
                frame = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
            self._target_frame = frame
            if not self._seen_generated:
                self._seen_generated = True
                self._fade_origin = self._display_frame
                self._fade_remaining = self._fade_steps
        elif self._seen_generated:
            frame = self._target_frame
        if self._fade_remaining:
            alpha = (self._fade_steps - self._fade_remaining + 1) / self._fade_steps
            frame = cv2.addWeighted(self._fade_origin, 1 - alpha, self._target_frame, alpha, 0)
            self._fade_remaining -= 1
        self._display_frame = frame
        self.output.push_video_frame(frame)
        self.record_video_data(frame)

    def _publish_audio(self, packet):
        pcm = (np.clip(packet.data, -1, 1) * 32767).astype(np.int16)
        self.output.push_audio_frame(pcm, packet.userdata)
        self.record_audio_data(pcm)

    def _publish(self, frame, packets, generated=False):
        self._publish_video(frame, generated)
        self.speaking = any(packet.type == 0 for packet in packets)
        for packet in packets:
            self._publish_audio(packet)

    def _streaming_tick(self, state):
        generation = self.asr.generation
        if state['generation'] != generation:
            state.update(generation=generation, started=False, next_frame=None,
                         frame=None, position=0)

        def next_frame():
            while True:
                try:
                    item = self.generated.get_nowait()
                except queue.Empty:
                    return None
                if item[0] == generation:
                    return item

        if state['next_frame'] is None:
            state['next_frame'] = next_frame()
        if not state['started']:
            if state['next_frame'] is None or self.asr.playback.empty():
                self._publish(self.frame_list_cycle[0], [silence(), silence()])
                return
            state['started'] = True

        changed = False
        while state['next_frame'] is not None and state['next_frame'][3] <= state['position']:
            state['frame'] = state['next_frame'][1]
            state['next_frame'] = next_frame()
            changed = True
        self._publish_video(state['frame'] if changed else self.frame_list_cycle[0], generated=changed)
        packets = []
        for _ in range(2):
            item = self.asr.pop_playback()
            if item is not None and item[0] == generation:
                packet = item[1]
                state['position'] = packet.position + 320
            else:
                packet = silence()
            packets.append(packet)
            self._publish_audio(packet)
        self.speaking = any(packet.type == 0 for packet in packets)

    def render(self, quit_event):
        self.quit_event = quit_event
        thread = threading.Thread(target=self._generate, args=(quit_event,), name='generative-inference')
        deadline = time.monotonic()
        stream_state = {'generation': self.asr.generation, 'started': False,
                        'next_frame': None, 'frame': None, 'position': 0}
        try:
            self.tts.render(quit_event)
            self.output.start()
            thread.start()
            while not quit_event.is_set():
                if self.shutdown_event.is_set():
                    quit_event.set()
                    break
                # Existing WebRTC queues are consumed on media timestamps.
                if self.output.get_buffer_size() > 4:
                    quit_event.wait(.02)
                    deadline = time.monotonic()
                    continue
                wait = deadline - time.monotonic()
                if wait > 0 and quit_event.wait(wait):
                    break
                deadline = max(deadline + .04, time.monotonic())
                with self.asr.lock:
                    if not self.buffered_playback:
                        self._streaming_tick(stream_state)
                    else:
                        try:
                            generation, frame, packets = self.generated.get_nowait()
                            if generation != self.asr.generation:
                                continue
                            generated = True
                        except queue.Empty:
                            frame, packets = self.frame_list_cycle[0], [silence(), silence()]
                            generated = False
                        self._publish(frame, packets, generated)
        except Exception as error:
            if not quit_event.is_set():
                self.render_error = str(error)
                logger.exception('Generative avatar output failed')
                self.notify({'status': 'error', 'message': self.render_error})
        finally:
            quit_event.set()
            self.asr.close()
            self.worker.close()  # Unblocks an in-flight GPU request immediately.
            if thread.ident is not None:
                thread.join(timeout=5)
            self.model_runtime.release(self.worker)
            self.output.stop()
            self.speaking = False

    def close(self):
        self.shutdown_event.set()
        self.asr.close()
        if getattr(self, 'quit_event', None) is not None:
            self.quit_event.set()
        self.model_runtime.release(self.worker)
