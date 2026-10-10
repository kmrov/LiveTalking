import tempfile
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from avatars.generative.avtr1_engine import Engine


class FakeFrame:
    def __init__(self, rgb):
        self.data = cv2.cvtColor(rgb, cv2.COLOR_RGB2YUV_I420)


class FakePipeline:
    def __init__(self):
        self.calls = []

    def process_chunk(self, avatar, chunk, state, options):
        self.calls.append((chunk, state, options))
        rgb = np.full((32, 32, 3), 127, np.uint8)
        return (len(self.calls), iter(FakeFrame(rgb) for _ in range(5)))


class AvtrEngineTests(unittest.TestCase):
    def test_window_state_and_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'portrait.png'
            cv2.imwrite(str(source), np.zeros((32, 32, 3), np.uint8))
            pipeline = FakePipeline()
            engine = Engine({'root': folder, 'weights': folder})
            with patch.object(engine, '_load_pipeline', return_value=(pipeline, {'studio': object()})):
                engine.start(source)
            self.addCleanup(engine.close)
            package = types.ModuleType('avtr1_renderer')
            package.__path__ = []
            pipeline_module = types.ModuleType('avtr1_renderer.pipeline')
            pipeline_module.TRANSPARENT_BG_ID = 'transparent'
            types_module = types.ModuleType('avtr1_renderer.types')
            types_module.Chunk = lambda **kwargs: types.SimpleNamespace(**kwargs)
            types_module.RenderOptions = lambda **kwargs: types.SimpleNamespace(**kwargs)
            with patch.dict(sys.modules, {'avtr1_renderer': package,
                                          'avtr1_renderer.pipeline': pipeline_module,
                                          'avtr1_renderer.types': types_module}):
                self.exercise_engine(engine, pipeline)

    def exercise_engine(self, engine, pipeline):
            frames = list(engine.render(np.full(3200, .1, np.float32),
                                        future=np.full(3280, .2, np.float32),
                                        listen=np.full(6480, .3, np.float32)))
            self.assertEqual(len(frames), 5)
            self.assertEqual(frames[0].shape, (32, 32, 3))
            self.assertAlmostEqual(float(pipeline.calls[0][0].audio_speech[3200]), .2)
            self.assertAlmostEqual(float(pipeline.calls[0][0].audio_listen[0]), .3)
            list(engine.render(np.zeros(3200, np.float32), future=np.zeros(3280, np.float32),
                               listen=np.zeros(6480, np.float32)))
            self.assertEqual(pipeline.calls[1][1], 1)
            engine.reset()
            list(engine.render(np.zeros(3200, np.float32), future=np.zeros(3280, np.float32),
                               listen=np.zeros(6480, np.float32)))
            self.assertIsNone(pipeline.calls[2][1])


if __name__ == '__main__':
    unittest.main()
