import io
import asyncio
import json
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from server.qwen3_asr import transcribe_pcm


class Qwen3ASRTest(unittest.TestCase):
    def test_sends_wav_to_vllm_transcription_api(self):
        response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"text": "Привет, как дела?"})
        opt = SimpleNamespace(ASR_SERVER="http://127.0.0.1:8092/", ASR_MODEL="Qwen/Qwen3-ASR-0.6B")
        audio = np.array([0, 16384, -16384], dtype="<i2").tobytes()
        with patch("server.qwen3_asr.requests.post", return_value=response) as post:
            text = transcribe_pcm(audio, opt)
        self.assertEqual(text, "Привет, как дела?")
        args = post.call_args
        self.assertEqual(args.args[0], "http://127.0.0.1:8092/v1/audio/transcriptions")
        self.assertEqual(args.kwargs["data"]["model"], "Qwen/Qwen3-ASR-0.6B")
        wav_bytes = args.kwargs["files"]["file"][1]
        with wave.open(io.BytesIO(wav_bytes)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getframerate(), wav.getsampwidth()), (1, 16000, 2))
            self.assertEqual(wav.readframes(3), audio)

    def test_rejects_missing_server(self):
        with self.assertRaisesRegex(ValueError, "ASR_SERVER"):
            transcribe_pcm(b"\0\0", SimpleNamespace(ASR_SERVER="", ASR_MODEL="model"))

    def test_browser_websocket_returns_qwen_transcript(self):
        from aiohttp import WSMsgType
        from server.asr_server import asr_websocket_handler

        class FakeSocket:
            sent = []

            async def prepare(self, request):
                pass

            async def send_str(self, value):
                self.sent.append(json.loads(value))

            def __aiter__(self):
                async def messages():
                    yield SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps({"is_speaking": True, "mode": "2pass"}))
                    yield SimpleNamespace(type=WSMsgType.BINARY, data=b"\0\0" * 400)
                    yield SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps({"is_speaking": False}))
                return messages()

        socket = FakeSocket()
        request = SimpleNamespace(remote="127.0.0.1", app={"opt": SimpleNamespace(ASR_BACKEND="qwen3asr")})
        class InlineExecutor:
            def run_in_executor(self, pool, function, *args):
                future = asyncio.get_running_loop().create_future()
                future.set_result(function(*args))
                return future

        with patch("server.asr_server.web.WebSocketResponse", return_value=socket), patch(
            "server.asr_server.asyncio.get_event_loop", return_value=InlineExecutor()
        ), patch(
            "server.qwen3_asr.transcribe_pcm", return_value="Привет, мир"
        ) as transcribe:
            asyncio.run(asr_websocket_handler(request))
        self.assertEqual(socket.sent, [{"text": "Привет, мир", "mode": "2pass-offline", "is_final": True, "timestamp": None}])
        self.assertEqual(len(transcribe.call_args.args[0]), 800)


if __name__ == "__main__":
    unittest.main()
