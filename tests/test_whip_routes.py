import unittest
import warnings
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from aiohttp.web_app import NotAppKeyWarning

from server import rtc_manager
from server.routes import setup_routes
from tests.test_whip_push import FakePeerConnection, FakeSessions


class WhipControlRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []

        async def receive(request):
            self.requests.append(("POST", request.headers.get("Authorization")))
            return web.Response(status=201, text="v=0\r\ns=answer\r\n",
                                content_type="application/sdp",
                                headers={"Location": "/whip/session/lease"})

        async def remove(request):
            self.requests.append(("DELETE", request.headers.get("Authorization")))
            return web.Response(status=204)

        receiver = web.Application()
        receiver.router.add_post("/whip", receive)
        receiver.router.add_delete("/whip/session/lease", remove)
        self.receiver = TestServer(receiver)
        await self.receiver.start_server()
        self.manager = rtc_manager.RTCManager(SimpleNamespace())
        self.opt = SimpleNamespace(transport="rtcpush")

        app = web.Application()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", NotAppKeyWarning)
            app["rtc_manager"] = self.manager
            app["opt"] = self.opt
        setup_routes(app)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

        self.fake_pc = patch.object(rtc_manager, "RTCPeerConnection", FakePeerConnection)
        self.fake_sessions = patch.object(rtc_manager, "session_manager", FakeSessions())
        self.fake_player = patch("server.webrtc.HumanPlayer", return_value=SimpleNamespace(audio=object(), video=object()))
        self.fake_pc.start()
        self.fake_sessions.start()
        self.fake_player.start()

    async def asyncTearDown(self):
        await self.manager.shutdown()
        self.fake_player.stop()
        self.fake_sessions.stop()
        self.fake_pc.stop()
        await self.client.close()
        await self.receiver.close()

    async def test_connect_status_disconnect_without_exposing_token(self):
        url = str(self.receiver.make_url("/whip"))
        response = await self.client.post("/api/whip/connect", json={"url": url, "token": "secret-for-test"})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["data"], {"state": "connected", "url": url})

        response = await self.client.post("/api/whip/connect", json={"url": url, "token": "secret-for-test"})
        self.assertEqual(response.status, 409)

        response = await self.client.get("/api/whip/status")
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["data"], {"state": "connected", "url": url})
        self.assertNotIn("secret-for-test", await response.text())

        response = await self.client.post("/api/whip/disconnect")
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["data"], {"state": "disconnected", "url": ""})
        self.assertEqual(self.requests, [("POST", "Bearer secret-for-test"),
                                         ("DELETE", "Bearer secret-for-test")])

    async def test_rejects_invalid_url_and_foreign_origin(self):
        response = await self.client.post("/api/whip/connect", json={"url": "file:///tmp/whip", "token": "x"})
        self.assertEqual(response.status, 400)
        response = await self.client.post("/api/whip/connect", json={"url": "http://[broken", "token": "x"})
        self.assertEqual(response.status, 400)
        response = await self.client.post("/api/whip/connect", json={"url": str(self.receiver.make_url("/whip")), "token": "x"},
                                          headers={"Origin": "https://foreign.example"})
        self.assertEqual(response.status, 403)
        self.assertEqual(self.requests, [])

    async def test_localhost_page_can_read_status(self):
        port = self.client.make_url("/api/whip/status").port
        response = await self.client.get("/api/whip/status", headers={
            "Host": f"localhost:{port}",
            "Origin": f"http://localhost:{port}",
        })
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["data"]["state"], "disconnected")

    async def test_webrtc_server_can_push_whip_on_the_same_port(self):
        self.opt.transport = "webrtc"
        url = str(self.receiver.make_url("/whip"))
        response = await self.client.post("/api/whip/connect", json={"url": url, "token": "same-port-secret"})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["data"], {"state": "connected", "url": url})
        response = await self.client.post("/api/whip/disconnect")
        self.assertEqual(response.status, 200)
        self.assertEqual(self.requests, [("POST", "Bearer same-port-secret"),
                                         ("DELETE", "Bearer same-port-secret")])


if __name__ == "__main__":
    unittest.main()
