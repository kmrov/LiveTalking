import math
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np


class PiperTTSTest(unittest.TestCase):
    def test_russian_audio_reaches_avatar_as_16khz_frames(self):
        from tts.piper_tts import PiperTTS

        class Voice:
            def synthesize_wav(self, text, wav_file):
                self.text = text
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(24000)
                samples = np.array(
                    [math.sin(2 * math.pi * 440 * i / 24000) * 12000 for i in range(2400)],
                    dtype=np.int16,
                )
                wav_file.writeframes(samples.tobytes())

        voice = Voice()
        frames = []
        parent = SimpleNamespace(put_audio_frame=lambda audio, event: frames.append((audio, event)))
        opt = SimpleNamespace(fps=25, REF_FILE="models/ru_RU-irina-medium.onnx")

        with patch("piper.PiperVoice.load", return_value=voice):
            tts = PiperTTS(opt, parent)
        tts.txt_to_audio(("Привет, мир!", {"request_id": "demo"}))

        self.assertEqual(voice.text, "Привет, мир!")
        self.assertEqual(len(frames), 5)
        self.assertTrue(all(len(audio) == 320 for audio, _ in frames))
        self.assertTrue(any(np.any(audio != 0) for audio, _ in frames))
        self.assertEqual(frames[0][1], {"status": "start", "text": "Привет, мир!", "request_id": "demo"})
        self.assertEqual(frames[-1][1], {"status": "end", "text": "Привет, мир!", "request_id": "demo"})


if __name__ == "__main__":
    unittest.main()
