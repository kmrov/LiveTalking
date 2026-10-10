import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from aiohttp import web

from server.listen_audio import listen_audio


SESSION = '00000000-0000-0000-0000-000000000001'


def request(body=b'\0\0', *, sessionid=SESSION, origin=None, content_type='application/octet-stream', model='avtr1', chunk_size=None):
    offset = 0
    async def read(limit):
        nonlocal offset
        end = min(len(body), offset + limit, offset + (chunk_size or limit))
        chunk = body[offset:end]
        offset = end
        return chunk
    return SimpleNamespace(
        remote='127.0.0.1', host='127.0.0.1:8010', scheme='http',
        headers={} if origin is None else {'Origin': origin}, query={'sessionid': sessionid},
        content_type=content_type, content_length=len(body), content=SimpleNamespace(read=read),
        app={'opt': SimpleNamespace(model=model)},
    )


class ListenAudioRouteTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.received = []
        self.avatar = SimpleNamespace(
            opt=SimpleNamespace(model='avtr1'),
            put_listen_audio=lambda pcm: self.received.append(pcm),
        )
        self.session = patch('server.listen_audio.session_manager.get_session', return_value=self.avatar)
        self.session.start()

    def tearDown(self):
        self.session.stop()

    async def test_forwards_pcm16_as_mono_float32_to_selected_session(self):
        response = await listen_audio(request(b'\x00\x80\x00\x00\xff\x7f', origin='null'))
        self.assertEqual(response.status, 200)
        self.assertEqual(len(self.received), 1)
        self.assertEqual(self.received[0].dtype, np.float32)
        np.testing.assert_allclose(self.received[0], [-1, 0, 32767 / 32768])

    async def test_reads_fragmented_request_body_before_forwarding(self):
        await listen_audio(request(b'\x00\x80\x00\x00\xff\x7f', chunk_size=2))
        np.testing.assert_allclose(self.received[0], [-1, 0, 32767 / 32768])

    async def test_rejects_foreign_origin_invalid_session_and_malformed_audio(self):
        cases = (
            (request(origin='https://foreign.example'), web.HTTPForbidden),
            (request(sessionid='../../secret'), web.HTTPBadRequest),
            (request(b'\0'), web.HTTPBadRequest),
            (request(b'\0' * 32002), web.HTTPRequestEntityTooLarge),
            (request(content_type='text/plain'), web.HTTPUnsupportedMediaType),
        )
        for attempted, error in cases:
            with self.subTest(error=error), self.assertRaises(error):
                await listen_audio(attempted)
        self.assertEqual(self.received, [])

    async def test_rejects_missing_or_other_model_session(self):
        self.avatar.opt.model = 'soulx'
        with self.assertRaises(web.HTTPConflict):
            await listen_audio(request())
        self.avatar.opt.model = 'avtr1'
        with self.assertRaises(web.HTTPConflict):
            await listen_audio(request(model='soulx'))
        self.assertEqual(self.received, [])
