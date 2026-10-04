"""Alignment tests replace expensive neural inference, not engine buffering."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from avatars.generative.ditto_engine import Engine


class Motion:
    seq_frames = 80

    def setup(self, source, **kwargs):
        self.previous = None
        self.source = source
        self.options = kwargs

    def __call__(self, cond, previous):
        self.previous = previous
        self.condition = cond.copy()
        return cond.copy()

    def cvt_fmt(self, values):
        return list(values[0])


class Features:
    def wav2feat(self, audio, sr):
        return np.zeros((len(audio) // 640, 1), np.float32)

    def __call__(self, window, chunksize):
        # Hubert's centered five-frame window begins after 3 frames + 80 samples.
        return window[2000:5200].reshape(5, 640).mean(axis=1)[:, None]


class Stitch:
    def setup(self, **kwargs):
        self.d0 = None
        self.options = kwargs

    def __call__(self, source, motion):
        return None, motion


def fake_sdk():
    source = {"is_image_flag": True, "x_s_info_lst": [{}],
              "f_s_lst": [None], "M_c2o_lst": [None],
              "img_rgb_lst": [np.zeros((2, 2, 3), np.uint8)]}
    return SimpleNamespace(
        default_kwargs={},
        avatar_registrar=lambda *a, **k: source,
        condition_handler=SimpleNamespace(setup=lambda *a, **k: None, x_s_info_0={}),
        audio2motion=Motion(), motion_stitch=Stitch(), wav2feat=Features(),
        warp_f3d=lambda features, source, motion: motion,
        decode_f3d=lambda motion: np.full((2, 2, 3), round(float(motion[0]) * 100), np.uint8),
        putback=lambda source, frame, transform: frame,
    )


class DittoEngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / "source.png"
        self.source.touch()
        self.sdk = fake_sdk()
        self.engine = Engine({"root": self.tmp.name, "weights": self.tmp.name})
        self.loader = patch.object(self.engine, "_load_sdk", return_value=self.sdk)
        self.loader.start()
        self.addCleanup(self.loader.stop)
        # Callable condition handler retaining setup and source reference.
        class Condition:
            x_s_info_0 = {}
            def setup(self, source, *args, ch_info=None, **kwargs):
                self.x_s_info_0 = (source if ch_info is None else ch_info)["x_s_info_lst"][0]
            def __call__(self, audio, idx): return audio
        self.sdk.condition_handler = Condition()
        self.engine.start(str(self.source))

    def test_first_and_later_chunks_emit_current_audio_without_warmup(self):
        for start in (1, 21):
            audio = np.repeat(np.arange(start, start + 20, dtype=np.float32) / 100, 640)
            frames = list(self.engine.render(audio))
            self.assertEqual([int(frame[0, 0, 0]) for frame in frames], list(range(start, start + 20)))
        self.assertIsNotNone(self.sdk.audio2motion.previous)

    def test_reset_discards_history_without_reloading_models(self):
        list(self.engine.render(np.ones(12800, np.float32)))
        self.engine.reset()
        frames = list(self.engine.render(np.full(12800, 0.25, np.float32)))
        self.assertEqual(len(frames), 20)
        self.assertEqual(int(frames[0][0, 0, 0]), 25)
        self.assertIsNone(self.sdk.audio2motion.previous)
        self.assertEqual(self.engine._load_sdk.call_count, 1)

    def test_history_preserves_previous_audio_and_reset_discards_it(self):
        list(self.engine.render(np.full(12800, 0.1, np.float32)))
        list(self.engine.render(np.full(12800, 0.2, np.float32)))
        np.testing.assert_allclose(self.sdk.audio2motion.condition[0, 40:60, 0], 0.1)
        np.testing.assert_allclose(self.sdk.audio2motion.condition[0, 60:80, 0], 0.2)
        self.engine.reset()
        list(self.engine.render(np.full(12800, 0.3, np.float32)))
        np.testing.assert_array_equal(self.sdk.audio2motion.condition[0, :60, 0], 0)

    def test_released_canonical_motion_template_and_resets_are_preserved(self):
        template = {"x_s_info_lst": [{"template": "canonical"}]}
        self.sdk.default_kwargs.update(ch_info=template, fix_kp_cond=1, fix_kp_cond_dim=[0, 202])
        self.engine.reset()
        self.assertEqual(self.sdk.audio2motion.source, {"template": "canonical"})
        self.assertEqual(self.sdk.audio2motion.options["fix_kp_cond"], 1)
        self.assertEqual(self.sdk.audio2motion.options["fix_kp_cond_dim"], [0, 202])
        self.assertIs(self.sdk.motion_stitch.options["ch_info"], template)

    def test_invalid_audio_cannot_advance_motion(self):
        for audio in (np.zeros(640, np.float32), np.zeros((12800, 1), np.float32),
                      np.full(12800, np.nan, np.float32), np.zeros(12800, np.int16)):
            with self.subTest(shape=audio.shape, dtype=audio.dtype):
                with self.assertRaises(ValueError):
                    list(self.engine.render(audio))

    def test_close_releases_session_and_rejects_render(self):
        self.engine.close()
        self.engine.close()
        with self.assertRaises(RuntimeError):
            list(self.engine.render(np.zeros(12800, np.float32)))


if __name__ == "__main__":
    unittest.main()
