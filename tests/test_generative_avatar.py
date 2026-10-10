import threading
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

from avatars.generative_avatar import GenerativeAvatar, ModelRuntime, load_avatar


class FakeWorker:
    chunk_frames = 2

    def __init__(self, fps=25):
        self.fps = fps
        self.chunk_samples = self.chunk_frames * 16000 // fps
        self.started = threading.Event()
        self.resume = threading.Event()
        self.closed = threading.Event()
        self.resets = 0
        self.render_calls = 0

    def render(self, audio):
        self.render_calls += 1
        self.started.set()
        if not self.resume.wait(3) or self.closed.is_set():
            raise RuntimeError('closed or timed out')
        for _ in range(2):
            yield np.full((32, 32, 3), 140, np.uint8)

    def reset(self):
        self.resets += 1

    def close(self):
        self.closed.set()
        self.resume.set()


class Output:
    def __init__(self):
        self.audio = []
        self.video = []
        self.spoken = threading.Event()

    def start(self): pass
    def stop(self): pass
    def get_buffer_size(self): return 0
    def push_video_frame(self, frame): self.video.append(frame)
    def push_audio_frame(self, pcm, data):
        self.audio.append((pcm.copy(), data))
        if data.get('status') == 'end':
            self.spoken.set()


class GenerativeAvatarTests(unittest.TestCase):
    def test_avtr1_created_marker_is_accepted_by_runtime_loader(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path.cwd()
            try:
                os.chdir(folder)
                avatar_dir = Path('data/avatars/portrait')
                (avatar_dir / 'full_imgs').mkdir(parents=True)
                image = np.zeros((32, 32, 3), np.uint8)
                import cv2
                cv2.imwrite(str(avatar_dir / 'full_imgs/00000000.png'), image)
                (avatar_dir / 'generative-avatar.json').write_text(json.dumps({'version': 1, 'model': 'avtr1'}))
                self.assertEqual(load_avatar('portrait')['model'], 'avtr1')
            finally:
                os.chdir(original)

    def test_avtr1_listening_audio_drives_idle_render(self):
        class AvtrWorker:
            fps = 25
            chunk_frames = 5
            chunk_samples = 3200
            future_samples = 3280
            def __init__(self):
                self.calls = []
                self.closed = threading.Event()
            def render(self, audio, *, future=None, listen=None):
                self.calls.append((audio.copy(), future.copy(), listen.copy()))
                return [np.full((32, 32, 3), 80, np.uint8) for _ in range(5)]
            def reset(self): pass
            def close(self): self.closed.set()
        worker = AvtrWorker()
        avatar, _, quit = self.make_avatar(worker=worker, buffered=False, model_name='avtr1')
        avatar.put_listen_audio(np.full(3200, .4, np.float32))
        deadline = __import__('time').monotonic() + 2
        while not worker.calls and __import__('time').monotonic() < deadline:
            quit.wait(.02)
        self.assertTrue(worker.calls)
        self.assertAlmostEqual(float(worker.calls[0][2][-1]), .4)
        while not any(int(frame.mean()) > 20 for frame in avatar.output.video) and __import__('time').monotonic() < deadline:
            quit.wait(.02)
        self.assertTrue(any(int(frame.mean()) > 20 for frame in avatar.output.video),
                        'microphone motion must reach the idle video output')
        for index in range(20):
            avatar.asr.put_audio_frame(np.full(320, .1 if index < 10 else .2, np.float32),
                                       {'status': 'end'} if index == 19 else {})
        while not any(float(call[0][0]) > 0 for call in worker.calls) and __import__('time').monotonic() < deadline:
            quit.wait(.02)
        speech_calls = [call for call in worker.calls if float(call[0][0]) > 0]
        self.assertTrue(speech_calls)
        self.assertAlmostEqual(float(speech_calls[0][1][0]), .2)

    def make_avatar(self, worker=None, buffered=True, model_name=None, idle_frames=None):
        worker = worker or FakeWorker(fps=25 if buffered else 20)
        model_name = model_name or ('ditto' if buffered else 'soulx')
        model = SimpleNamespace(config={'model': model_name, 'buffered_playback': buffered}, idle_frames=idle_frames or [], acquire=lambda source: worker,
                                release=lambda client: client.close())
        opt = SimpleNamespace(fps=25, sessionid='test', batch_size=2, tts='fixture',
                              transport='webrtc', model=model_name, customopt=[])
        avatar = GenerativeAvatar(opt, model, {'model': model_name, 'source': 'test.png',
                                              'frame': np.zeros((32, 32, 3), np.uint8)})
        avatar.tts = SimpleNamespace(render=lambda quit: None, flush_talk=lambda: None)
        avatar.output = Output()
        quit = threading.Event()
        thread = threading.Thread(target=avatar.render, args=(quit,))
        thread.start()
        def cleanup():
            quit.set()
            avatar.close()
            thread.join(4)
            self.assertFalse(thread.is_alive())
        self.addCleanup(cleanup)
        return avatar, worker, quit

    def test_model_runtime_prepares_silent_frames_and_resets_before_speech(self):
        class SilentWorker:
            chunk_samples = 1280
            def __init__(self):
                self.audio = None
                self.resets = 0
            def render(self, audio):
                self.audio = audio.copy()
                yield np.full((32, 32, 3), 60, np.uint8)
                yield np.full((32, 32, 3), 120, np.uint8)
            def reset(self): self.resets += 1
            def close(self): pass
        worker = SilentWorker()
        with patch('avatars.generative_avatar.open_worker', return_value=worker):
            runtime = ModelRuntime({'model': 'ditto'}, 'test.png')
        self.addCleanup(runtime.close)
        self.assertEqual(len(runtime.idle_frames), 2)
        self.assertTrue(np.all(worker.audio == 0))
        self.assertEqual(worker.resets, 1)

    def test_model_runtime_bounds_idle_cache_for_large_images(self):
        class LargeWorker:
            chunk_samples = 1280
            def render(self, audio):
                yield np.full((2000, 2000, 3), 60, np.uint8)
            def reset(self): pass
            def close(self): pass
        with patch('avatars.generative_avatar.open_worker', return_value=LargeWorker()):
            runtime = ModelRuntime({'model': 'ditto'}, 'test.png')
        self.addCleanup(runtime.close)
        self.assertLessEqual(max(runtime.idle_frames[0].shape[:2]), 1280)

    def test_idle_frames_move_before_first_phrase(self):
        idle = [np.full((32, 32, 3), shade, np.uint8) for shade in (60, 120)]
        avatar, worker, quit = self.make_avatar(idle_frames=idle)
        deadline = __import__('time').monotonic() + 1
        while len(avatar.output.video) < 10 and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        shades = [int(frame.mean()) for frame in avatar.output.video[-4:]]
        self.assertIn(60, shades)
        self.assertIn(120, shades)
        self.assertEqual(worker.render_calls, 0)

    def test_idle_cache_uses_output_size_only_when_memory_is_bounded(self):
        worker = FakeWorker()
        model = SimpleNamespace(config={'model': 'ditto'}, idle_frames=[np.zeros((16, 16, 3), np.uint8)] * 4,
                                acquire=lambda source: worker, release=lambda client: client.close())
        opt = SimpleNamespace(fps=25, sessionid='test', batch_size=2, tts='fixture',
                              transport='webrtc', model='ditto', customopt=[])
        small = GenerativeAvatar(opt, model, {'model': 'ditto', 'source': 'test.png',
                                               'frame': np.zeros((32, 32, 3), np.uint8)})
        self.assertEqual(small.frame_list_cycle[0].shape[:2], (32, 32))
        large = GenerativeAvatar(opt, model, {'model': 'ditto', 'source': 'test.png',
                                               'frame': np.zeros((4000, 4000, 3), np.uint8)})
        self.assertEqual(large.frame_list_cycle[0].shape[:2], (16, 16))
        worker.close()

    def test_soulx_idle_frames_keep_their_20_fps_timing(self):
        idle = [np.full((32, 32, 3), shade, np.uint8) for shade in (10, 20, 30, 40)]
        avatar, worker, quit = self.make_avatar(buffered=False, idle_frames=idle)
        deadline = __import__('time').monotonic() + 2
        while len(avatar.output.video) < 20 and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        shades = [int(frame.mean()) for frame in avatar.output.video[8:20]]
        self.assertGreaterEqual(sum(a == b for a, b in zip(shades, shades[1:])), 2,
                                '20 fps idle video needs repeated frames on the 25 fps output clock')

    def test_streaming_waits_for_audio_across_tts_pause(self):
        avatar, worker, quit = self.make_avatar(buffered=False)
        worker.resume.set()
        avatar.put_audio_frame(np.full(320, .25, np.float32), {'status': 'start'})
        self.assertFalse(worker.started.wait(.25), 'A short TTS pause must not start a padded video block')
        for i in range(3):
            avatar.put_audio_frame(np.full(320, .25, np.float32), {'status': 'end'} if i == 2 else {})
        self.assertTrue(avatar.output.spoken.wait(2))

    def test_soulx_starts_on_short_block_then_uses_full_blocks(self):
        class StagedWorker(FakeWorker):
            chunk_frames = 4
            startup_frames = 2
            startup_samples = 1600

            def __init__(self):
                super().__init__(fps=20)
                self.audio_lengths = []

            def render(self, audio):
                self.audio_lengths.append(len(audio))
                for _ in range(2 if len(audio) == 1600 else 4):
                    yield np.full((32, 32, 3), 140, np.uint8)

        avatar, worker, _ = self.make_avatar(StagedWorker(), buffered=False)
        for i in range(5):
            avatar.put_audio_frame(np.full(320, .25, np.float32),
                                   {'status': 'start'} if i == 0 else {})
        deadline = __import__('time').monotonic() + 1
        while not worker.audio_lengths and __import__('time').monotonic() < deadline:
            __import__('time').sleep(.01)
        self.assertEqual(worker.audio_lengths, [1600], 'First speech must not wait for a full 24-frame block')
        for i in range(10):
            avatar.put_audio_frame(np.full(320, .25, np.float32),
                                   {'status': 'end'} if i == 9 else {})
        self.assertTrue(avatar.output.spoken.wait(2))
        self.assertEqual(worker.audio_lengths, [1600, 3200])

    def test_streaming_does_not_publish_padded_tail_or_reset_between_phrases(self):
        avatar, worker, quit = self.make_avatar(buffered=False)
        worker.resume.set()
        queued = []
        original = avatar._enqueue_frame
        def capture(item, event):
            queued.append(item)
            original(item, event)
        avatar._enqueue_frame = capture
        for phrase in ('first', 'second'):
            avatar.put_audio_frame(np.ones(320, np.float32), {'phrase': phrase, 'status': 'start'})
            avatar.put_audio_frame(np.zeros(320, np.float32), {'phrase': phrase, 'status': 'end'})
        deadline = __import__('time').monotonic() + 2
        while worker.render_calls < 2 or avatar.inference_active:
            if __import__('time').monotonic() > deadline:
                self.fail('Two phrases did not finish rendering')
            quit.wait(.01)
        self.assertEqual(worker.resets, 0)
        self.assertEqual(len(queued), 2, 'Only frames aligned to real TTS packets should be published')
        self.assertEqual([item[3] for item in queued], [0, 640])

    def test_streaming_audio_does_not_pause_when_second_video_block_is_late(self):
        class DelayedSecondBlock(FakeWorker):
            def __init__(self):
                super().__init__(fps=20)
                self.resume.set()
            def render(self, audio):
                if self.render_calls == 1:
                    threading.Event().wait(.28)
                yield from super().render(audio)
        avatar, worker, quit = self.make_avatar(DelayedSecondBlock(), buffered=False)
        for i in range(10):
            event = {'status': 'start'} if i == 0 else {'status': 'end'} if i == 9 else {}
            avatar.put_audio_frame(np.full(320, .25, np.float32), event)
        self.assertTrue(avatar.output.spoken.wait(3))
        output = avatar.output.audio
        start = next(i for i, (_, event) in enumerate(output) if event.get('status') == 'start')
        end = next(i for i, (_, event) in enumerate(output) if event.get('status') == 'end')
        self.assertEqual(end - start, 9)
        self.assertTrue(all(np.max(pcm) > 1000 for pcm, _ in output[start:end + 1]))

    def test_streaming_next_phrase_waits_for_its_first_video_frame(self):
        class DelayedNextPhrase(FakeWorker):
            def __init__(self):
                super().__init__(fps=20)
                self.second_started = threading.Event()
                self.second_resume = threading.Event()

            def render(self, audio):
                self.render_calls += 1
                if self.render_calls == 2:
                    self.second_started.set()
                    if not self.second_resume.wait(3):
                        raise RuntimeError('Second phrase timed out')
                for _ in range(2):
                    yield np.full((32, 32, 3), 100 + 40 * self.render_calls, np.uint8)

        worker = DelayedNextPhrase()
        self.addCleanup(worker.second_resume.set)
        avatar, _, quit = self.make_avatar(worker, buffered=False)
        avatar._fade_steps = 0
        for phrase in ('first', 'second'):
            for i in range(5):
                avatar.put_audio_frame(np.full(320, .25, np.float32),
                                       {'phrase': phrase, 'status': 'start' if i == 0 else 'end' if i == 4 else ''})
        self.assertTrue(avatar.output.spoken.wait(2))
        self.assertTrue(worker.second_started.wait(2))
        quit.wait(.2)
        self.assertFalse(any(event.get('phrase') == 'second' for _, event in avatar.output.audio),
                         'The next phrase must not run ahead of its delayed video')
        worker.second_resume.set()
        deadline = __import__('time').monotonic() + 2
        while not any(event.get('phrase') == 'second' for _, event in avatar.output.audio):
            if __import__('time').monotonic() > deadline:
                self.fail('Second phrase never resumed')
            quit.wait(.01)
        second_audio = next(i for i, (_, event) in enumerate(avatar.output.audio)
                            if event.get('phrase') == 'second')
        self.assertGreater(avatar.output.video[second_audio // 2].mean(), 140,
                           'The next phrase must start with its own generated frame')

    def test_streaming_20fps_frames_follow_25fps_audio_timeline(self):
        class DistinctFrames(FakeWorker):
            def render(self, audio):
                self.started.set()
                yield np.full((32, 32, 3), 100, np.uint8)
                yield np.full((32, 32, 3), 150, np.uint8)
        avatar, worker, quit = self.make_avatar(DistinctFrames(fps=20), buffered=False)
        avatar._fade_steps = 0
        for i in range(5):
            avatar.put_audio_frame(np.full(320, .25, np.float32),
                                   {'status': 'start'} if i == 0 else {'status': 'end'} if i == 4 else {})
        self.assertTrue(avatar.output.spoken.wait(2))
        start = next(i for i, (_, event) in enumerate(avatar.output.audio) if event.get('status') == 'start')
        frames = [int(frame.mean()) for frame in avatar.output.video[start // 2:start // 2 + 3]]
        self.assertEqual(frames, [100, 100, 150])

    def test_streaming_interrupt_removes_old_playback_audio(self):
        avatar, worker, quit = self.make_avatar(buffered=False)
        for i in range(5):
            avatar.put_audio_frame(np.full(320, .75, np.float32), {'turn': 'old'})
        self.assertTrue(worker.started.wait(2))
        avatar.flush_talk()
        avatar.put_audio_frame(np.full(320, .25, np.float32), {'turn': 'new', 'status': 'end'})
        worker.resume.set()
        self.assertTrue(avatar.output.spoken.wait(2))
        events = [event for _, event in avatar.output.audio if event]
        self.assertEqual([event['turn'] for event in events], ['new'])

    def test_speech_fades_back_to_moving_idle_frames(self):
        idle = [np.full((32, 32, 3), shade, np.uint8) for shade in (60, 120)]
        avatar, worker, quit = self.make_avatar(buffered=False, idle_frames=idle)
        worker.resume.set()
        avatar.put_audio_frame(np.ones(320, np.float32), {'status': 'start'})
        avatar.put_audio_frame(np.zeros(320, np.float32), {'status': 'end'})
        self.assertTrue(avatar.output.spoken.wait(2))
        quit.wait(.3)
        visible = [frame.mean() for frame in avatar.output.video if frame.mean() > 0]
        self.assertTrue(visible)
        self.assertLess(visible[0], 140, 'The first generated frame should fade in')
        shades = [int(frame.mean()) for frame in avatar.output.video[-4:]]
        self.assertIn(60, shades)
        self.assertIn(120, shades)

    def test_no_audio_before_matching_frames_and_end_metadata_preserved(self):
        avatar, worker, quit = self.make_avatar()
        avatar._fade_steps = 0
        avatar.put_audio_frame(np.ones(320, np.float32) * .5, {'status': 'end'})
        self.assertTrue(worker.started.wait(2))
        self.assertFalse(any(pcm.any() for pcm, _ in avatar.output.audio))
        worker.resume.set()
        self.assertTrue(avatar.output.spoken.wait(2))
        sample, metadata = next((p, d) for p, d in avatar.output.audio if d.get('status') == 'end')
        self.assertEqual(sample[0], 16383)
        # Frames and audio are published in pairs on the same render thread.
        deadline = __import__('time').monotonic() + 1
        while not any(frame.mean() == 140 for frame in avatar.output.video) and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        self.assertTrue(any(frame.mean() == 140 for frame in avatar.output.video))

    def test_interruption_discards_inflight_speech_and_accepts_new_turn(self):
        avatar, worker, quit = self.make_avatar()
        avatar.put_audio_frame(np.ones(320, np.float32) * .75, {'status': 'end', 'turn': 'old'})
        self.assertTrue(worker.started.wait(2))
        avatar.flush_talk()
        avatar.put_audio_frame(np.ones(320, np.float32) * .25, {'status': 'end', 'turn': 'new'})
        worker.resume.set()
        self.assertTrue(avatar.output.spoken.wait(2))
        events = [data for _, data in avatar.output.audio if data]
        self.assertEqual([event['turn'] for event in events], ['new'])
        self.assertGreaterEqual(worker.resets, 1)

    def test_close_before_render_start_releases_model(self):
        worker = FakeWorker()
        model = SimpleNamespace(config={'model': 'ditto'}, acquire=lambda source: worker,
                                release=lambda client: client.close())
        opt = SimpleNamespace(fps=25, sessionid='test', batch_size=2, tts='fixture',
                              transport='webrtc', model='ditto', customopt=[])
        avatar = GenerativeAvatar(opt, model, {'model': 'ditto', 'source': 'test.png',
                                              'frame': np.zeros((32, 32, 3), np.uint8)})
        avatar.close()
        self.assertTrue(worker.closed.is_set())

    def test_old_tts_packet_delivered_after_interrupt_is_rejected(self):
        avatar, worker, quit = self.make_avatar()
        producer = SimpleNamespace(_generation=1)
        avatar.put_tts_audio_frame(np.ones(320, np.float32), {'status': 'end'}, producer, 0)
        self.assertTrue(avatar.asr.queue.empty())
        avatar.put_tts_audio_frame(np.ones(320, np.float32), {'status': 'end'}, producer, 1)
        self.assertTrue(worker.started.wait(2))

    def test_output_start_failure_is_visible_and_worker_is_reaped(self):
        worker = FakeWorker()
        model = SimpleNamespace(config={'model': 'ditto'}, acquire=lambda source: worker,
                                release=lambda client: client.close())
        opt = SimpleNamespace(fps=25, sessionid='test', batch_size=2, tts='fixture',
                              transport='webrtc', model='ditto', customopt=[])
        avatar = GenerativeAvatar(opt, model, {'model': 'ditto', 'source': 'test.png',
                                              'frame': np.zeros((32, 32, 3), np.uint8)})
        avatar.tts = SimpleNamespace(render=lambda quit: None)
        avatar.output = Output()
        def fail():
            raise RuntimeError('Output unavailable')
        avatar.output.start = fail
        avatar.render(threading.Event())
        self.assertEqual(avatar.render_error, 'Output unavailable')
        self.assertTrue(worker.closed.is_set())

    def test_end_at_exact_chunk_boundary_resets_before_next_turn(self):
        avatar, worker, quit = self.make_avatar()
        for i in range(4):
            avatar.put_audio_frame(np.ones(320, np.float32), {'status': 'end'} if i == 3 else {})
        self.assertTrue(worker.started.wait(2))
        avatar.put_audio_frame(np.ones(320, np.float32), {'status': 'end'})
        worker.resume.set()
        # Completion of both output blocks proves the second render ran.
        deadline = __import__('time').monotonic() + 2
        while worker.resets == 0 and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        self.assertEqual(worker.resets, 1)

    def test_buffered_playback_waits_for_all_utterance_chunks(self):
        class TwoChunks(FakeWorker):
            def __init__(self):
                super().__init__()
                self.resume.set()
                self.calls = 0
                self.second_started = threading.Event()
                self.second_resume = threading.Event()
            def render(self, audio):
                self.calls += 1
                if self.calls == 2:
                    self.second_started.set()
                    if not self.second_resume.wait(2):
                        raise RuntimeError('Second chunk timed out')
                yield from super().render(audio)
        worker = TwoChunks()
        self.addCleanup(worker.second_resume.set)
        avatar, worker, quit = self.make_avatar(worker)
        for i in range(8):
            avatar.put_audio_frame(np.full(320,.25,np.float32), {'status':'end'} if i == 7 else {})
        self.assertTrue(worker.second_started.wait(2))
        self.assertTrue(avatar.pending_buffer)
        self.assertTrue(avatar.is_speaking())
        self.assertFalse(any(pcm.any() for pcm, _ in avatar.output.audio))
        worker.second_resume.set()
        self.assertTrue(avatar.output.spoken.wait(2))
        spoken = [pcm for pcm,_ in avatar.output.audio if pcm.any()]
        self.assertEqual(len(spoken),8)

    def test_buffered_soulx_20fps_preserves_all_audio_at_25fps_output(self):
        class TwentyFpsWorker(FakeWorker):
            chunk_frames = 4
            def __init__(self):
                super().__init__(fps=20)
                self.resume.set()
            def render(self, audio):
                self.render_calls += 1
                self.started.set()
                for i in range(4):
                    yield np.full((32, 32, 3), 100 + i, np.uint8)
        avatar, _, _ = self.make_avatar(TwentyFpsWorker(), buffered=True, model_name='soulx')
        for i in range(10):
            avatar.put_audio_frame(np.full(320, .25, np.float32),
                                   {'status': 'end'} if i == 9 else {})
        self.assertTrue(avatar.output.spoken.wait(2), 'Buffered SoulX must deliver the end packet')
        self.assertEqual(sum(bool(pcm.any()) for pcm, _ in avatar.output.audio), 10)

    def test_short_tts_gap_does_not_insert_silence_and_partial_input_stays_pending(self):
        avatar, worker, quit = self.make_avatar()
        worker.resume.set()
        avatar.put_audio_frame(np.full(320,.25,np.float32), {'status':'start'})
        self.assertFalse(worker.started.wait(.2), 'Buffered mode should wait through short TTS gaps')
        self.assertTrue(avatar.is_speaking(), 'The collected partial chunk is still pending speech')
        avatar.put_audio_frame(np.full(320,.5,np.float32), {'status':'end'})
        self.assertTrue(avatar.output.spoken.wait(2))
        output = avatar.output.audio
        start = next(i for i,(_,event) in enumerate(output) if event.get('status') == 'start')
        end = next(i for i,(_,event) in enumerate(output) if event.get('status') == 'end')
        self.assertEqual(end-start,1, 'Synthetic padding must not split the utterance')

    def test_interrupt_releases_buffered_playback_waiting_on_backpressure(self):
        avatar, worker, quit = self.make_avatar()
        avatar.output.get_buffer_size = lambda: 5
        worker.resume.set()
        for i in range(8):
            avatar.put_audio_frame(np.full(320,.75,np.float32), {'turn':'old','status':'end'} if i == 7 else {'turn':'old'})
        deadline = __import__('time').monotonic() + 2
        while not avatar.generated.full() and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        self.assertTrue(avatar.generated.full())
        avatar.flush_talk()
        avatar.put_audio_frame(np.full(320,.25,np.float32), {'status':'end','turn':'new'})
        avatar.output.get_buffer_size = lambda: 0
        self.assertTrue(avatar.output.spoken.wait(2))
        events = [event for _,event in avatar.output.audio if event]
        self.assertEqual([event['turn'] for event in events],['new'])

    def test_missing_end_marker_flushes_after_idle_gap_and_clears_pending(self):
        avatar, worker, quit = self.make_avatar()
        worker.resume.set()
        avatar.put_audio_frame(np.full(320,.25,np.float32), {'turn':'without-end'})
        deadline = __import__('time').monotonic() + 2
        while not any(event for _,event in avatar.output.audio) and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        self.assertEqual([event for _,event in avatar.output.audio if event],[{'turn':'without-end'}])
        deadline = __import__('time').monotonic() + 1
        while avatar.is_speaking() and __import__('time').monotonic() < deadline:
            quit.wait(.01)
        self.assertFalse(avatar.pending_buffer)
        self.assertFalse(avatar.is_speaking())


if __name__ == '__main__':
    unittest.main()
