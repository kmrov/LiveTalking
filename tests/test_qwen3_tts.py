import base64
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np


class Qwen3TTSTest(unittest.TestCase):
    def test_interrupt_tolerates_stream_close_race_without_hiding_active_errors(self):
        from tts.qwen3tts import Qwen3TTS
        from tts.base_tts import State

        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "voice.wav"
            reference.write_bytes(b"RIFF-example")
            opt = SimpleNamespace(fps=25, REF_FILE=str(reference), REF_TEXT="Образец", TTS_SERVER="http://localhost:8091")
            tts = Qwen3TTS(opt, SimpleNamespace(put_audio_frame=lambda audio, event: None))

            class ClosingResponse:
                def raise_for_status(self):
                    pass

                def iter_content(self, chunk_size):
                    yield np.ones(960, dtype="<i2").tobytes()
                    tts.flush_talk()
                    raise AttributeError("'NoneType' object has no attribute 'read'")

                def close(self):
                    pass

            with patch("tts.qwen3tts.requests.post", return_value=ClosingResponse()):
                tts.txt_to_audio(("Прерванный ответ", {}))

            tts.state = State.RUNNING
            response = SimpleNamespace(raise_for_status=lambda: None, iter_content=lambda chunk_size: (_ for _ in ()).throw(AttributeError('active error')), close=lambda: None)
            with patch("tts.qwen3tts.requests.post", return_value=response):
                with self.assertRaisesRegex(AttributeError, 'active error'):
                    tts.txt_to_audio(("Новый ответ", {}))

    def test_interrupt_closes_active_stream(self):
        from tts.qwen3tts import Qwen3TTS

        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "voice.wav"
            reference.write_bytes(b"RIFF-example")
            frames = []
            parent = SimpleNamespace(put_audio_frame=lambda audio, event: frames.append(event))
            opt = SimpleNamespace(fps=25, REF_FILE=str(reference), REF_TEXT="Образец", TTS_SERVER="http://localhost:8091")
            tts = Qwen3TTS(opt, parent)

            class FakeResponse:
                closed = False

                def raise_for_status(self):
                    pass

                def iter_content(self, chunk_size):
                    yield np.ones(960, dtype="<i2").tobytes()
                    tts.flush_talk()
                    yield np.ones(960, dtype="<i2").tobytes()

                def close(self):
                    self.closed = True

            response = FakeResponse()
            with patch("tts.qwen3tts.requests.post", return_value=response):
                tts.txt_to_audio(("Первый ответ", {}))
            self.assertTrue(response.closed)
            self.assertTrue(frames)
            self.assertFalse(any(event.get("status") == "end" for event in frames))

    def test_streamed_audio_has_no_clicks_at_frame_boundaries(self):
        from tts.qwen3tts import Qwen3TTS

        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "voice.wav"
            reference.write_bytes(b"RIFF-example")
            timeline = np.arange(24000, dtype=np.float32) / 24000
            source = (np.sin(2 * np.pi * 440 * timeline) * 16000).astype("<i2").tobytes()
            response = SimpleNamespace(
                raise_for_status=lambda: None,
                iter_content=lambda chunk_size=None: iter([source[:101], source[101:17003], source[17003:]]),
                close=lambda: None,
            )
            frames = []
            parent = SimpleNamespace(put_audio_frame=lambda audio, event: frames.append(audio))
            opt = SimpleNamespace(fps=25, REF_FILE=str(reference), REF_TEXT="Образец", TTS_SERVER="http://localhost:8091")
            with patch("tts.qwen3tts.requests.post", return_value=response):
                Qwen3TTS(opt, parent).txt_to_audio(("Проверка", {}))

            speech = np.concatenate(frames[:-1])
            self.assertEqual(len(speech), 16000)
            boundaries = np.arange(320, len(speech), 320)
            self.assertLess(np.max(np.abs(speech[boundaries] - speech[boundaries - 1])), 0.1)

    def test_russian_clone_stream_reaches_avatar_as_16khz_frames(self):
        from tts.qwen3tts import Qwen3TTS

        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "voice.wav"
            with wave.open(str(reference), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(24000)
                out.writeframes(np.ones(2400, dtype="<i2").tobytes())

            samples = np.full(2400, 8000, dtype="<i2").tobytes()
            response = SimpleNamespace(
                status_code=200,
                raise_for_status=lambda: None,
                iter_content=lambda chunk_size=None: iter([samples[:13], samples[13:2000], samples[2000:]]),
                close=lambda: None,
            )
            frames = []
            parent = SimpleNamespace(put_audio_frame=lambda audio, event: frames.append((audio, event)))
            opt = SimpleNamespace(
                fps=25,
                REF_FILE=str(reference),
                REF_TEXT="Привет, это образец моего голоса.",
                TTS_SERVER="http://127.0.0.1:8091",
            )
            with patch("tts.qwen3tts.requests.post", return_value=response) as post:
                tts = Qwen3TTS(opt, parent)
                tts.txt_to_audio(("Как дела?", {"request_id": "demo"}))

            body = post.call_args.kwargs["json"]
            self.assertEqual(body["input"], "Как дела?")
            self.assertEqual(body["language"], "Russian")
            self.assertEqual(body["task_type"], "Base")
            self.assertEqual(body["ref_text"], "Привет, это образец моего голоса.")
            self.assertEqual(body["response_format"], "pcm")
            self.assertTrue(body["stream"])
            self.assertTrue(body["ref_audio"].startswith("data:audio/wav;base64,"))
            self.assertEqual(base64.b64decode(body["ref_audio"].split(",", 1)[1]), reference.read_bytes())
            self.assertEqual(len(frames), 6)  # 100 ms of speech plus an end marker
            self.assertTrue(all(len(audio) == 320 for audio, _ in frames))
            self.assertTrue(all(np.any(audio != 0) for audio, _ in frames[:-1]))
            self.assertEqual(frames[0][1], {"status": "start", "text": "Как дела?", "request_id": "demo"})
            self.assertEqual(frames[-1][1], {"status": "end", "text": "Как дела?", "request_id": "demo"})


if __name__ == "__main__":
    unittest.main()
