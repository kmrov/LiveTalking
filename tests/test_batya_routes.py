import asyncio
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
    async def test_switch_conversation_preserves_avatar_session_and_stops_old_speech(self):
        old_id, new_id = str(uuid4()), str(uuid4())
        avatar = Avatar(old_id)
        transport = Transport()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(avatar, 'Старый разговор', 'old-turn')
        await transport.started.wait()
        self.assertEqual(avatar.speech, ['Привет, сынок.'])
        request = Request({'sessionid': 'projection', 'conversation_id': new_id},
                          {'batya_brain': brain})
        with patch('server.routes.get_session', return_value=avatar):
            response = await routes.set_brain_session(request)
        self.assertEqual(json.loads(response.text)['data']['conversation_id'], new_id)
        self.assertEqual(avatar.opt.batya_conversation_id, new_id)
        self.assertEqual(avatar.talk_generation, 1)
        self.assertEqual(avatar.speech, [])
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(avatar.speech, [])
        self.assertTrue(any(event['event'] == 'done' and event['conversation_id'] == old_id
                            for event in avatar.events))
        await brain.close()

    async def test_switch_conversation_rejects_invalid_id_without_interrupting(self):
        avatar = Avatar(str(uuid4()))
        original = avatar.opt.batya_conversation_id
        request = Request({'sessionid': 'projection', 'conversation_id': 'invalid'},
                          {'batya_brain': object()})
        with patch('server.routes.get_session', return_value=avatar):
            response = await routes.set_brain_session(request)
        self.assertNotEqual(json.loads(response.text)['code'], 0)
        self.assertEqual(avatar.opt.batya_conversation_id, original)
        self.assertEqual(avatar.talk_generation, 0)

    async def test_sse_reconnect_subscribes_to_pending_conversation_and_cleans_up(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        transport, original = Transport(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(original, 'Привет', 'one')
        await transport.started.wait()
        reconnected = Avatar(transport.id)
        app = web.Application()
        app['batya_brain'] = brain
        app.router.add_get('/sse', routes.sse_handler)
        async def read_event(response):
            while True:
                line = await asyncio.wait_for(response.content.readline(), 2)
                if line.startswith(b'data: '):
                    return json.loads(line[6:])
        with patch.object(routes.session_manager, 'get_session', return_value=reconnected):
            async with TestClient(TestServer(app, shutdown_timeout=0.05)) as client:
                response = await client.get('/sse?sessionid=new')
                snapshot = await read_event(response)
                self.assertEqual(snapshot['event'], 'snapshot')
                self.assertEqual(snapshot['pending'], 1)
                transport.release.set()
                await brain.wait_idle()
                events = [await read_event(response) for _ in range(3)]
                self.assertEqual([e['event'] for e in events], ['delta', 'done', 'idle'])
                self.assertEqual(events[1]['text'], 'Привет, сынок. Как дела?')
        self.assertEqual(len(brain.listeners), 0)
        await brain.close()

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
