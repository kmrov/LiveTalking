"""Send 16 kHz PCM utterances to a local Qwen3-ASR vLLM server."""

import io
import wave

import requests


def transcribe_pcm(pcm16: bytes, opt) -> str:
    server = getattr(opt, "ASR_SERVER", "").rstrip("/")
    if not server:
        raise ValueError("ASR_SERVER must be set for Qwen3-ASR")
    if len(pcm16) % 2:
        pcm16 = pcm16[:-1]
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm16)
    response = requests.post(
        f"{server}/v1/audio/transcriptions",
        data={"model": getattr(opt, "ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")},
        files={"file": ("utterance.wav", wav_buffer.getvalue(), "audio/wav")},
        timeout=(5, 120),
    )
    response.raise_for_status()
    return response.json()["text"].strip()
