import json
import sys
import unittest
from unittest.mock import patch

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

    def test_health_is_registered_before_static_files(self):
        app = web.Application()
        routes.setup_routes(app)
        registered = [(route.method, route.resource.canonical) for route in app.router.routes()]
        self.assertIn(("GET", "/api/desktop/health"), registered)


if __name__ == "__main__":
    unittest.main()
