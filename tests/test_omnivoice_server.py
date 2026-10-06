import base64
import io
import json
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import numpy as np
import soundfile as sf

from scripts.omnivoice_server import create_server, speech_chunks


class FakeModel:
    sampling_rate = 24000

    def __init__(self):
        self.prompts = 0
        self.calls = []
        self.block_second = False
        self.second_started = threading.Event()
        self.release_second = threading.Event()

    def create_voice_clone_prompt(self, ref_audio, ref_text):
        self.prompts += 1
        assert ref_audio[1] == 24000
        return (ref_text, len(ref_audio[0]))

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if self.block_second and len(self.calls) == 2:
            self.second_started.set()
            if not self.release_second.wait(timeout=5):
                raise TimeoutError('Second chunk was never released')
        return [np.array([0, 0.5, -0.5], dtype=np.float32)]


class OmniVoiceServerTests(unittest.TestCase):
    def test_short_reply_splits_at_sentence_boundary(self):
        self.assertEqual(speech_chunks('Привет! Я рад снова тебя видеть. Расскажи, как прошёл твой день?'), [
            'Привет! Я рад снова тебя видеть.', 'Расскажи, как прошёл твой день?'])

    def setUp(self):
        self.model = FakeModel()
        self.server = create_server('127.0.0.1', 0, self.model)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_qwen_compatible_clone_request_reuses_prompt_and_returns_pcm(self):
        audio = io.BytesIO()
        sf.write(audio, np.zeros(2400, dtype=np.float32), 24000, format='WAV')
        body = {'input': 'Привет', 'ref_audio': 'data:audio/wav;base64,' + base64.b64encode(audio.getvalue()).decode(),
                'ref_text': 'Образец', 'language': 'Russian', 'response_format': 'pcm', 'stream': True}
        for _ in range(2):
            request = Request(self.url + '/v1/audio/speech', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
            with urlopen(request) as response:
                pcm = np.frombuffer(response.read(), dtype='<i2')
                self.assertEqual(pcm.tolist(), [0, 16384, -16384])
        self.assertEqual(self.model.prompts, 1)
        self.assertEqual(self.model.calls[0]['voice_clone_prompt'][0], 'Образец')
        self.assertEqual(self.model.calls[0]['text'], 'Привет')
        self.assertEqual(self.model.calls[0]['num_step'], 16)
        with urlopen(self.url + '/v1/models') as response:
            self.assertEqual(json.load(response)['data'][0]['id'], 'k2-fsa/OmniVoice')

    def test_invalid_reference_is_rejected_without_running_model(self):
        body = {'input': 'Привет', 'ref_audio': 'data:audio/wav;base64,***',
                'ref_text': 'Образец', 'response_format': 'pcm'}
        request = Request(self.url + '/v1/audio/speech', data=json.dumps(body).encode())
        with self.assertRaises(HTTPError) as failure:
            urlopen(request)
        self.assertEqual(failure.exception.code, 400)
        self.assertEqual(self.model.calls, [])

    def test_stream_sends_first_sentence_before_second_finishes(self):
        audio = io.BytesIO()
        sf.write(audio, np.zeros(2400, dtype=np.float32), 24000, format='WAV')
        body = {'input': 'Привет! Я рад снова тебя видеть. Расскажи, как прошёл твой день? Сегодня будет ещё одна фраза.',
                'ref_audio': 'data:audio/wav;base64,' + base64.b64encode(audio.getvalue()).decode(),
                'ref_text': 'Образец', 'response_format': 'pcm', 'stream': True}
        self.model.block_second = True
        request = Request(self.url + '/v1/audio/speech', data=json.dumps(body).encode())
        try:
            with urlopen(request, timeout=5) as response:
                self.assertEqual(response.headers['Transfer-Encoding'], 'chunked')
                self.assertEqual(np.frombuffer(response.read(6), dtype='<i2').tolist(), [0, 16384, -16384])
                self.assertTrue(self.model.second_started.wait(timeout=2))
                self.model.release_second.set()
                self.assertGreater(len(response.read()), 0)
        finally:
            self.model.release_second.set()
        self.assertGreaterEqual(len(self.model.calls), 2)
        self.assertEqual(self.model.calls[0]['pad_duration'], 0.02)

    def test_startup_preloads_voice_and_warms_generation(self):
        audio = io.BytesIO()
        sf.write(audio, np.zeros(2400, dtype=np.float32), 24000, format='WAV')
        model = FakeModel()
        server = create_server('127.0.0.1', 0, model, warm_reference=(audio.getvalue(), 'Образец'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertEqual(model.prompts, 1)
            self.assertGreaterEqual(len(model.calls[0]['text']), 40)
            body = {'input': 'Здравствуйте', 'ref_audio': 'data:audio/wav;base64,' + base64.b64encode(audio.getvalue()).decode(),
                    'ref_text': 'Образец', 'response_format': 'pcm', 'stream': True}
            request = Request(f'http://127.0.0.1:{server.server_port}/v1/audio/speech', data=json.dumps(body).encode())
            with urlopen(request) as response:
                self.assertTrue(response.read())
            self.assertEqual(model.prompts, 1)
            self.assertEqual(model.calls[1]['text'], 'Здравствуйте')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
