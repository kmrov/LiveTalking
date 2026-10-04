"""Qwen3-TTS Base voice cloning through a vLLM-Omni speech server."""

import base64
from pathlib import Path
from threading import Lock

import numpy as np
import requests
import soxr

from registry import register
from utils.logger import logger
from .base_tts import BaseTTS, State


@register("tts", "qwen3tts")
class Qwen3TTS(BaseTTS):
    source_rate = 24000

    def flush_talk(self):
        self._generation += 1
        super().flush_talk()
        with self._response_lock:
            response = self._active_response
        if response is not None:
            response.close()

    def __init__(self, opt, parent):
        super().__init__(opt, parent)
        self._generation = 0
        self._response_lock = Lock()
        self._active_response = None
        if not opt.REF_TEXT or not opt.REF_TEXT.strip():
            raise ValueError("Qwen3-TTS Base requires REF_TEXT: the exact transcript of REF_FILE")
        reference = Path(opt.REF_FILE).expanduser()
        if not reference.is_file():
            raise FileNotFoundError(f"Qwen3-TTS reference WAV not found: {reference}")
        if reference.suffix.lower() != ".wav":
            raise ValueError("Qwen3-TTS REF_FILE must be a WAV file")
        self.ref_audio = "data:audio/wav;base64," + base64.b64encode(reference.read_bytes()).decode("ascii")
        self.ref_text = opt.REF_TEXT.strip()
        self.server_url = opt.TTS_SERVER.rstrip("/")
        if not self.server_url:
            raise ValueError("Qwen3-TTS requires TTS_SERVER (vLLM-Omni URL)")

    def txt_to_audio(self, msg: tuple[str, dict]):
        generation = self._generation
        text, textevent = msg
        body = {
            "input": text,
            "language": "Russian",
            "task_type": "Base",
            "ref_audio": self.ref_audio,
            "ref_text": self.ref_text,
            "stream": True,
            "stream_format": "audio",
            "response_format": "pcm",
        }
        response = None
        first = True
        pending_bytes = b""
        pending_audio = np.empty(0, dtype=np.float32)
        resampler = soxr.ResampleStream(self.source_rate, self.sample_rate, 1, dtype="float32")

        def deliver(audio, event):
            guarded_delivery = getattr(self.parent, 'put_tts_audio_frame', None)
            if callable(guarded_delivery):
                guarded_delivery(audio, event, self, generation)
            else:
                self.parent.put_audio_frame(audio, event)

        def emit(audio):
            nonlocal first, pending_audio
            if audio.size:
                pending_audio = np.concatenate((pending_audio, audio))
            while len(pending_audio) >= self.chunk and self.state == State.RUNNING and self._generation == generation:
                event = {**textevent}
                if first:
                    event.update(status="start", text=text)
                    first = False
                deliver(pending_audio[:self.chunk].copy(), event)
                pending_audio = pending_audio[self.chunk:]

        try:
            response = requests.post(
                f"{self.server_url}/v1/audio/speech",
                json=body,
                stream=True,
                timeout=(5, 120),
            )
            with self._response_lock:
                self._active_response = response
            response.raise_for_status()
            if self._generation != generation:
                return
            for chunk in response.iter_content(chunk_size=4096):
                if self.state != State.RUNNING or self._generation != generation:
                    break
                pcm = pending_bytes + chunk
                usable = len(pcm) - len(pcm) % 2
                pending_bytes = pcm[usable:]
                if usable:
                    source = np.frombuffer(pcm[:usable], dtype="<i2").astype(np.float32) / 32768.0
                    emit(resampler.resample_chunk(source))
            if self.state == State.RUNNING and self._generation == generation:
                emit(resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True))
                if pending_audio.size:
                    event = {**textevent}
                    if first:
                        event.update(status="start", text=text)
                        first = False
                    deliver(np.pad(pending_audio, (0, self.chunk - len(pending_audio))), event)
        except Exception as error:
            # Closing a requests stream from flush_talk can invalidate an
            # in-flight urllib3 read. Cancellation must not kill the TTS worker.
            if self._generation != generation or self.state != State.RUNNING:
                logger.debug("Qwen3-TTS stream cancelled")
            elif isinstance(error, requests.RequestException):
                logger.exception("Qwen3-TTS request failed")
            else:
                raise
        finally:
            with self._response_lock:
                if self._active_response is response:
                    self._active_response = None
            if response is not None:
                response.close()
            if not first and self._generation == generation:
                deliver(
                    np.zeros(self.chunk, dtype=np.float32),
                    {**textevent, "status": "end", "text": text},
                )
