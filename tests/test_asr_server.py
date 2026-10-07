import asyncio
import importlib.util
import json
import sys
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "server" / "asr_server.py"


class FakeLogger:
    def info(self, *args, **kwargs):
        pass

    def warning(self, *args, **kwargs):
        pass

    def exception(self, *args, **kwargs):
        pass


def load_asr_server(auto_model):
    fake_utils = types.ModuleType("utils")
    fake_logger_module = types.ModuleType("utils.logger")
    fake_logger_module.logger = FakeLogger()

    fake_aiohttp = types.ModuleType("aiohttp")
    fake_aiohttp.web = types.SimpleNamespace(
        WebSocketResponse=object,
        WSMsgType=types.SimpleNamespace(
            TEXT="TEXT",
            BINARY="BINARY",
            ERROR="ERROR",
            CLOSE="CLOSE",
        ),
    )

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)

    fake_funasr = types.ModuleType("funasr")
    fake_funasr.AutoModel = auto_model
    fake_funasr_utils = types.ModuleType("funasr.utils")
    fake_postprocess = types.ModuleType("funasr.utils.postprocess_utils")
    fake_postprocess.rich_transcription_postprocess = lambda text: text

    fake_soundfile = types.ModuleType("soundfile")
    fake_soundfile.write = lambda *args, **kwargs: None

    injected_modules = {
        "utils": fake_utils,
        "utils.logger": fake_logger_module,
        "aiohttp": fake_aiohttp,
        "torch": fake_torch,
        "funasr": fake_funasr,
        "funasr.utils": fake_funasr_utils,
        "funasr.utils.postprocess_utils": fake_postprocess,
        "soundfile": fake_soundfile,
    }
    module_name = f"asr_server_under_test_{time.time_ns()}"
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, injected_modules):
        spec.loader.exec_module(module)
    return module, injected_modules


class ASRServerConcurrencyTestCase(unittest.TestCase):
    def test_lazy_model_load_constructs_one_model_across_threads(self):
        constructor_started = threading.Event()
        release_constructor = threading.Event()
        constructor_calls = []
        calls_lock = threading.Lock()

        class FakeModel:
            pass

        def auto_model(**options):
            with calls_lock:
                constructor_calls.append(options)
                constructor_started.set()
            release_constructor.wait(timeout=2)
            return FakeModel()

        module, injected_modules = load_asr_server(auto_model)
        with patch.dict(sys.modules, injected_modules):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(module._load_sensevoice)
                self.assertTrue(constructor_started.wait(timeout=1))
                second = pool.submit(module._load_sensevoice)
                try:
                    time.sleep(0.1)
                    self.assertEqual(len(constructor_calls), 1)
                finally:
                    release_constructor.set()

                first_model = first.result(timeout=2)
                second_model = second.result(timeout=2)

        self.assertIs(first_model, second_model)

    def test_shared_model_generate_is_serialized_across_threads(self):
        first_generate_entered = threading.Event()
        second_generate_entered = threading.Event()
        release_generate = threading.Event()
        state_lock = threading.Lock()
        active_calls = 0

        class FakeModel:
            def generate(self, **options):
                nonlocal active_calls
                with state_lock:
                    active_calls += 1
                    if active_calls == 1:
                        first_generate_entered.set()
                    else:
                        second_generate_entered.set()
                try:
                    release_generate.wait(timeout=2)
                    return [{"text": "ok"}]
                finally:
                    with state_lock:
                        active_calls -= 1

        module, injected_modules = load_asr_server(lambda **options: FakeModel())
        module._sensevoice_model = FakeModel()
        audio = np.zeros(1600, dtype=np.float32)

        with patch.dict(sys.modules, injected_modules):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(module._run_inference, audio, 16000, False)
                self.assertTrue(first_generate_entered.wait(timeout=1))
                second = pool.submit(module._run_inference, audio, 16000, False)
                try:
                    self.assertFalse(second_generate_entered.wait(timeout=0.2))
                finally:
                    release_generate.set()

                first.result(timeout=2)
                second.result(timeout=2)


class ASRServerPartialTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_qwen_streams_prefix_then_final_when_requested(self):
        module, injected = load_asr_server(lambda **options: None)

        class FakeSocket:
            def __init__(self):
                self.messages = asyncio.Queue()
                self.sent = []

            async def prepare(self, request):
                pass

            def __aiter__(self):
                return self

            async def __anext__(self):
                message = await self.messages.get()
                if message is None:
                    raise StopAsyncIteration
                return message

            async def send_str(self, value):
                self.sent.append(json.loads(value))

            async def receive(self, kind, data):
                await self.messages.put(types.SimpleNamespace(type=kind, data=data))

        socket = FakeSocket()
        module.web.WebSocketResponse = lambda: socket
        calls = []
        fake_qwen = types.ModuleType('server.qwen3_asr')

        def transcribe(pcm, opt):
            calls.append(len(pcm))
            return 'Привет' if len(pcm) < 40000 else 'Привет, как дела'

        fake_qwen.transcribe_pcm = transcribe
        injected['server.qwen3_asr'] = fake_qwen
        request = types.SimpleNamespace(remote='test', app={'opt': types.SimpleNamespace(ASR_BACKEND='qwen3asr')})
        loop = asyncio.get_running_loop()
        with patch.dict(sys.modules, injected), patch.object(
            loop, 'run_in_executor', side_effect=lambda executor, fn, *args: asyncio.sleep(0, result=fn(*args))
        ):
            task = asyncio.create_task(module.asr_websocket_handler(request))
            await socket.receive(module.web.WSMsgType.TEXT, json.dumps({
                'mode': 'offline', 'is_speaking': True, 'partial_results': True,
            }))
            await socket.receive(module.web.WSMsgType.BINARY, bytes(32000))
            for _ in range(100):
                if socket.sent:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(socket.sent, [{
                'text': 'Привет', 'mode': 'offline', 'is_final': False, 'timestamp': None,
            }])
            await socket.receive(module.web.WSMsgType.BINARY, bytes(32000))
            await socket.receive(module.web.WSMsgType.TEXT, json.dumps({'is_speaking': False}))
            for _ in range(100):
                if len(socket.sent) > 1:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(socket.sent[-1]['text'], 'Привет, как дела')
            self.assertTrue(socket.sent[-1]['is_final'])
            self.assertEqual(calls, [32000, 64000])
            await socket.messages.put(None)
            await task
            self.assertEqual([item for item in asyncio.all_tasks() if item is not asyncio.current_task()], [])


if __name__ == "__main__":
    unittest.main()
