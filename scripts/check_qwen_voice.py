"""Smoke test the two model servers without starting the avatar.

Example:
    python scripts/check_qwen_voice.py --ref-file voice.wav --ref-text 'Exact transcript.'
"""

import argparse
import base64
import io
from pathlib import Path
import wave

import requests


def main():
    parser = argparse.ArgumentParser(description="Check Qwen3-TTS and Qwen3-ASR together")
    parser.add_argument("--asr-server", default="http://127.0.0.1:8092")
    parser.add_argument("--asr-model", default="Qwen/Qwen3-ASR-0.6B")
    parser.add_argument("--tts-server", default="http://127.0.0.1:8091")
    parser.add_argument("--ref-file", type=Path, required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--text", default="Здравствуйте! Проверяем русский голосовой аватар.")
    parser.add_argument("--output", type=Path, default=Path("qwen3-voice-check.wav"))
    args = parser.parse_args()

    reference = args.ref_file.read_bytes()
    payload = {
        "input": args.text,
        "language": "Russian",
        "task_type": "Base",
        "ref_audio": "data:audio/wav;base64," + base64.b64encode(reference).decode("ascii"),
        "ref_text": args.ref_text,
        "stream": True,
        "stream_format": "audio",
        "response_format": "pcm",
    }
    with requests.post(
        args.tts_server.rstrip("/") + "/v1/audio/speech",
        json=payload,
        stream=True,
        timeout=(5, 120),
    ) as response:
        response.raise_for_status()
        pcm = b"".join(response.iter_content(chunk_size=65536))
    if not pcm or len(pcm) % 2:
        raise RuntimeError("Qwen3-TTS returned no valid PCM16 audio")

    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(pcm)
    wav_bytes = wav_buffer.getvalue()
    args.output.write_bytes(wav_bytes)

    response = requests.post(
        args.asr_server.rstrip("/") + "/v1/audio/transcriptions",
        data={"model": args.asr_model},
        files={"file": (args.output.name, wav_bytes, "audio/wav")},
        timeout=(5, 120),
    )
    response.raise_for_status()
    print(f"Audio: {args.output}")
    print(f"Original: {args.text}")
    print(f"Recognized: {response.json()['text']}")


if __name__ == "__main__":
    main()
