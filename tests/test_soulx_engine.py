"""Streaming boundaries using a lightweight stand-in for GPU inference."""
import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image


class SoulXEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.source = root / "source.png"
        Image.new("RGB", (8, 8), "red").save(self.source)
        self.config = {key: str(root) for key in ("root", "weights", "wav2vec")}
        self.windows = []
        self.preparations = []
        self.pipeline = types.SimpleNamespace(generator=torch.Generator(), state=0)
        self.pipeline.reset_person_name = lambda: setattr(self.pipeline, "state", 0)
        inference = types.ModuleType("flash_head.inference")
        inference.infer_params = dict(sample_rate=16000, tgt_fps=25,
            cached_audio_duration=8, frame_num=33, motion_frames_num=9, sample_steps=4)
        inference.get_pipeline = lambda **kw: self.pipeline
        def prepare(pipeline, **kwargs):
            self.preparations.append({**kwargs, 'sampling_steps': inference.infer_params['sample_steps'],
                                      'frame_num': inference.infer_params['frame_num']})
            pipeline.state = 0
        inference.get_base_data = prepare
        inference.get_infer_params = lambda: dict(inference.infer_params)
        def embedding(pipeline, audio, start, end):
            self.windows.append((audio.copy(), start, end))
            return audio
        inference.get_audio_embedding = embedding
        def run(pipeline, embedding):
            frames = torch.arange(33).reshape(33, 1, 1, 1).expand(33, 2, 2, 3).float()
            frames = frames + pipeline.state * 40
            pipeline.state += 1
            return frames
        inference.run_pipeline = run
        pipeline_module = types.ModuleType("flash_head.src.pipeline.flash_head_pipeline")
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {"flash_head.inference": inference,
            "flash_head.src.pipeline.flash_head_pipeline": pipeline_module}).start()
        self.engine = importlib.import_module("avatars.generative.soulx_engine").Engine(self.config)
        self.addCleanup(self.engine.close)

    def test_returns_current_chunk_without_motion_context(self):
        self.engine.start(str(self.source))
        audio = np.ones(19200, np.float32)
        frames = self.engine.render(audio)
        self.assertEqual((self.engine.fps, self.engine.chunk_frames, len(frames)), (20, 24, 24))
        self.assertEqual(self.preparations[0]['sampling_steps'], 2)
        self.assertEqual(self.preparations[0]['frame_num'], 33)
        self.assertEqual(frames[0].dtype, np.uint8)
        self.assertEqual(frames[0].shape, (2, 2, 3))
        self.assertEqual((frames[0][0, 0, 0], frames[-1][0, 0, 0]), (9, 32))
        window, start, end = self.windows[-1]
        self.assertEqual((len(window), start, end), (128000, 127, 160))
        np.testing.assert_array_equal(window[-19200:], audio)
        self.assertFalse(window[:-19200].any())
        self.assertFalse(self.preparations[0]["use_face_crop"])

    def test_history_survives_chunks_and_reset_clears_motion_and_audio(self):
        self.engine.start(str(self.source))
        self.engine.render(np.ones(19200, np.float32))
        second = self.engine.render(np.full(19200, 2, np.float32))
        self.assertEqual(second[0][0, 0, 0], 49)
        np.testing.assert_array_equal(self.windows[-1][0][-38400:-19200], 1)
        self.engine.reset()
        third = self.engine.render(np.full(19200, 3, np.float32))
        self.assertEqual(third[0][0, 0, 0], 9)
        self.assertFalse(self.windows[-1][0][:-19200].any())
        self.assertEqual(len(self.preparations), 1, "reset must reuse encoded reference")

    def test_rejects_wrong_audio_and_closed_engine(self):
        self.engine.start(str(self.source))
        for audio in (np.zeros(1, np.float32), np.zeros((19200, 1), np.float32),
                      np.zeros(19200, np.float64), np.full(19200, np.nan, np.float32)):
            with self.assertRaises(ValueError):
                self.engine.render(audio)
        self.engine.close()
        with self.assertRaises(RuntimeError):
            self.engine.render(np.zeros(19200, np.float32))

    def test_rejects_incompatible_upstream_frame_count(self):
        self.engine.start(str(self.source))
        with patch.object(sys.modules["flash_head.inference"], "run_pipeline",
                          return_value=torch.zeros((32, 2, 2, 3))):
            with self.assertRaisesRegex(RuntimeError, "frames"):
                self.engine.render(np.zeros(19200, np.float32))

    def test_nonsquare_reference_preserves_full_image_and_output_geometry(self):
        Image.new("RGB", (8, 4), "red").save(self.source)
        self.engine.start(str(self.source))
        prepared = Path(self.preparations[0]["cond_image_path_or_dir"])
        with Image.open(prepared) as reference:
            self.assertEqual(reference.size, (8, 8))
            self.assertEqual(reference.getpixel((0, 0)), (0, 0, 0))
            self.assertEqual(reference.getpixel((0, 2)), (255, 0, 0))
            self.assertEqual(reference.getpixel((7, 5)), (255, 0, 0))
        video = torch.arange(8).reshape(1, 8, 1, 1).expand(33, 8, 8, 3).float()
        with patch.object(sys.modules["flash_head.inference"], "run_pipeline", return_value=video):
            frames = self.engine.render(np.zeros(19200, np.float32))
        self.assertEqual(frames.shape, (24, 4, 8, 3))
        self.assertEqual((frames[0, 0, 0, 0], frames[0, -1, 0, 0]), (2, 5))
        self.engine.close()
        self.assertFalse(prepared.exists())


if __name__ == "__main__":
    unittest.main()
