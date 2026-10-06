from pathlib import Path
import sys
import threading
import time
import unittest
import numpy as np

from avatars.generative.worker_client import WorkerClient


class WorkerClientTests(unittest.TestCase):
    def worker(self, mode='', timeout=10):
        script = Path(__file__).parent / 'fixtures/generative_worker.py'
        client = WorkerClient([sys.executable, str(script), mode], source='test.png', timeout=timeout)
        self.addCleanup(client.close)
        return client

    def test_frame_count_pixels_and_reset_roundtrip(self):
        client = self.worker()
        self.assertEqual(client.chunk_frames, 2)
        self.assertEqual(client.chunk_samples, 1280)
        frames = list(client.render(np.zeros(1280, dtype=np.float32)))
        self.assertEqual(len(frames), 2)
        self.assertLess(frames[0].mean(), 3)
        self.assertGreater(frames[1].mean(), 97)
        client.reset()
        self.assertEqual(len(list(client.render(np.zeros(1280, dtype=np.float32)))), 2)

    def test_short_response_and_worker_crash_fail(self):
        for mode in ('short', 'crash'):
            with self.subTest(mode=mode):
                client = self.worker(mode)
                with self.assertRaises(RuntimeError):
                    list(client.render(np.zeros(1280, dtype=np.float32)))

    def test_close_unblocks_inflight_inference_and_reaps_worker(self):
        client = self.worker('hang')
        entered = threading.Event()
        errors = []
        def render():
            entered.set()
            try:
                list(client.render(np.zeros(1280, dtype=np.float32)))
            except RuntimeError as error:
                errors.append(error)
        thread = threading.Thread(target=render)
        thread.start()
        entered.wait(1)
        client.close()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertIsNotNone(client.process.poll())
        self.assertTrue(errors)

    def test_wrong_audio_length_rejected_before_request(self):
        client = self.worker()
        with self.assertRaises(ValueError):
            list(client.render(np.zeros(640, dtype=np.float32)))

    def test_soulx_worker_accepts_20_frames_for_one_second_of_audio(self):
        client = self.worker('soulx')
        self.assertEqual((client.fps, client.chunk_frames, client.chunk_samples), (20, 24, 19200))
        self.assertEqual(len(list(client.render(np.zeros(19200, np.float32)))), 24)
        with self.assertRaises(ValueError):
            list(client.render(np.zeros(12800, np.float32)))

    def test_short_startup_block_then_regular_block(self):
        client = self.worker('soulx_startup')
        self.assertEqual((client.startup_frames, client.startup_samples), (8, 6400))
        self.assertEqual(len(list(client.render(np.zeros(6400, np.float32)))), 8)
        self.assertEqual(len(list(client.render(np.zeros(19200, np.float32)))), 24)
        with self.assertRaises(ValueError):
            list(client.render(np.zeros(12800, np.float32)))


if __name__ == '__main__':
    unittest.main()
