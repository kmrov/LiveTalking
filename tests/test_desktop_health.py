import json
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import os

from aiohttp import web

from config import parse_args
from server import routes


class DesktopHealthTest(unittest.IsolatedAsyncioTestCase):
    def test_listenhost_defaults_to_existing_public_bind(self):
        with patch.object(sys, "argv", ["app.py", "--config", ""]):
            options = parse_args()
        self.assertEqual(options.listenhost, "0.0.0.0")

    def test_listenhost_accepts_loopback_for_desktop(self):
        with patch.object(sys, "argv", ["app.py", "--config", "", "--listenhost", "127.0.0.1"]):
            options = parse_args()
        self.assertEqual(options.listenhost, "127.0.0.1")

    async def test_health_reports_desktop_api_version(self):
        response = await routes.desktop_health(None)
        self.assertEqual(response.status, 200)
        self.assertEqual(
            json.loads(response.text),
            {"code": 0, "msg": "ok", "data": {"service": "livetalking", "api_version": 1}},
        )

    async def test_generative_inference_failure_marks_service_unhealthy(self):
        for model in ('ditto', 'soulx', 'avtr1'):
            with self.subTest(model=model):
                request = SimpleNamespace(app={'opt': SimpleNamespace(model=model, llm_provider='direct')})
                with patch.object(routes.session_manager, 'sessions', {'test': SimpleNamespace(render_error='GPU inference failed')}):
                    response = await routes.desktop_health(request)
                self.assertEqual(response.status, 503)
                self.assertEqual(json.loads(response.text)['msg'], 'GPU inference failed')

    def test_health_is_registered_before_static_files(self):
        app = web.Application()
        routes.setup_routes(app)
        registered = [(route.method, route.resource.canonical) for route in app.router.routes()]
        self.assertIn(("GET", "/api/desktop/health"), registered)
        self.assertIn(("POST", "/api/desktop/listen-audio"), registered)
    async def test_health_identifies_process_model_and_canonical_avatar_checkout(self):
        request=SimpleNamespace(app={'opt':SimpleNamespace(model='musetalk',llm_provider='direct')})
        data=json.loads((await routes.desktop_health(request)).text)['data']
        self.assertEqual(data['avatar'],{'model':'musetalk','root':os.path.realpath(os.getcwd())})


if __name__ == "__main__":
    unittest.main()
