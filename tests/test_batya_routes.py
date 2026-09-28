import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from server import routes
from server.batya_brain import BatyaBrain
from tests.test_batya_brain import Avatar, Transport


class Request:
    def __init__(self, body, app):
        self.body, self.app = body, app
    async def json(self):
        return self.body


class BatyaRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def test_all_external_chat_calls_reach_batya_and_echo_remains_direct(self):
        transport, avatar = Transport(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        app = {'opt': SimpleNamespace(llm_provider='batya'), 'batya_brain': brain}
        request = Request({'sessionid': 'external', 'type': 'chat', 'text': 'Привет', 'request_id': 'one', 'interrupt': True}, app)
        with patch('server.routes.get_session', return_value=avatar):
            accepted = json.loads((await routes.human(request)).text)
            self.assertEqual(accepted['data']['request_id'], 'one')
            await transport.started.wait()
            generation = avatar.talk_generation
            await routes.human(request)
            self.assertEqual(avatar.talk_generation, generation)
            request.body = {'sessionid': 'external', 'type': 'echo', 'text': 'Эхо'}
            await routes.human(request)
        self.assertIn('Эхо', avatar.speech)
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(len(transport.calls), 1)
        await brain.close()

    async def test_batya_config_and_health_advertise_selected_brain(self):
        import sys
        from config import parse_args
        with patch.object(sys, 'argv', ['app.py', '--config', '', '--llm_provider', 'batya', '--batya_url', 'http://127.0.0.1:8000']):
            opt = parse_args()
        response = await routes.desktop_health(SimpleNamespace(app={'opt': opt}))
        self.assertEqual(json.loads(response.text)['data']['brain']['mode'], 'batya')

    def test_qwen_microphone_route_is_registered_in_committed_checkout(self):
        from aiohttp import web
        app = web.Application()
        app['opt'] = SimpleNamespace(ASR_BACKEND='qwen3asr')
        routes.setup_routes(app)
        self.assertIn('/api/asr', [route.resource.canonical for route in app.router.routes()])
