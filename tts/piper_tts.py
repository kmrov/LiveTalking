"""Offline Piper speech synthesis for the avatar audio stream."""

import wave
from io import BytesIO

import numpy as np
import resampy

from registry import register
from .base_tts import BaseTTS, State


@register("tts", "piper")
class PiperTTS(BaseTTS):
    def __init__(self, opt, parent):
        super().__init__(opt, parent)
        from piper import PiperVoice

        self.voice = PiperVoice.load(opt.REF_FILE)

    def txt_to_audio(self, msg: tuple[str, dict]):
        text, textevent = msg
        output = BytesIO()
        with wave.open(output, "wb") as wav_file:
            self.voice.synthesize_wav(text, wav_file)

        output.seek(0)
        with wave.open(output, "rb") as wav_file:
            sample_rate = wav_file.getframerate()
            audio = np.frombuffer(wav_file.readframes(wav_file.getnframes()), dtype="<i2")

        if audio.size == 0:
            return
        audio = audio.astype(np.float32) / 32768.0
        if sample_rate != self.sample_rate:
            audio = resampy.resample(audio, sample_rate, self.sample_rate)

        for start in range(0, len(audio), self.chunk):
            if self.state != State.RUNNING:
                break
            frame = audio[start:start + self.chunk]
            if len(frame) < self.chunk:
                frame = np.pad(frame, (0, self.chunk - len(frame)))
            event = {"text": text}
            if start == 0:
                event["status"] = "start"
            if start + self.chunk >= len(audio):
                event["status"] = "end"
            event.update(textevent)
            self.parent.put_audio_frame(frame, event)
