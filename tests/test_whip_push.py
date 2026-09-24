import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestServer

from server import rtc_manager


class FakePeerConnection:
    def __init__(self):
        self.localDescription = SimpleNamespace(sdp="v=0\r\ns=whip-test\r\n")
        self.remoteDescription = None
        self.closed = False
        self.connectionState = "connected"
        self.handlers = {}

    def on(self, event):
        def register(callback):
            self.handlers[event] = callback
            return callback
        return register

    def addTrack(self, _track):
        pass

    async def createOffer(self):
        return SimpleNamespace(type="offer", sdp=self.localDescription.sdp)

    async def setLocalDescription(self, _offer):
        pass

    async def setRemoteDescription(self, answer):
        self.remoteDescription = answer

    async def close(self):
        self.closed = True


class FakeSessions:
    def __init__(self):
        self.active = set()

    async def create_session(self, _params, _sessionid):
        if _sessionid in self.active:
            raise RuntimeError("session already exists")
        self.active.add(_sessionid)
        return "0"

    def get_session(self, _sessionid):
        return object()

    def remove_session(self, _sessionid):
        self.active.discard(_sessionid)


class WhipPushTest(unittest.IsolatedAsyncioTestCase):
    async def run_push(self, handler):
        app = web.Application()
        app.router.add_post("/whip", handler)
        server = TestServer(app)
        await server.start_server()
        manager = rtc_manager.RTCManager(SimpleNamespace())
        try:
            with patch.object(rtc_manager, "RTCPeerConnection", FakePeerConnection), \
                 patch.object(rtc_manager, "session_manager", FakeSessions()), \
                 patch("server.webrtc.HumanPlayer", return_value=SimpleNamespace(audio=object(), video=object())), \
                 patch.dict(os.environ, {"WHIP_BEARER_TOKEN": "test-secret"}):
                await manager.handle_rtcpush(str(server.make_url("/whip")), "0")
                await manager.shutdown()
        finally:
            await server.close()
        return manager

    async def test_posts_sdp_with_bearer_and_deletes_whip_session_on_shutdown(self):
        requests = []

        async def receive(request):
            requests.append((request.method, request.headers.get("Content-Type"),
                             request.headers.get("Authorization"), await request.text()))
            return web.Response(status=201, text="v=0\r\ns=answer\r\n",
                                content_type="application/sdp",
                                headers={"Location": "/whip/session/lease"})

        app = web.Application()
        app.router.add_post("/whip", receive)

        async def remove(request):
            requests.append((request.method, request.headers.get("Authorization"), request.path))
            return web.Response(status=204)

        app.router.add_delete("/whip/session/lease", remove)
        server = TestServer(app)
        await server.start_server()
        manager = rtc_manager.RTCManager(SimpleNamespace())
        try:
            with patch.object(rtc_manager, "RTCPeerConnection", FakePeerConnection), \
                 patch.object(rtc_manager, "session_manager", FakeSessions()), \
                 patch("server.webrtc.HumanPlayer", return_value=SimpleNamespace(audio=object(), video=object())), \
                 patch.dict(os.environ, {"WHIP_BEARER_TOKEN": "test-secret"}):
                await manager.handle_rtcpush(str(server.make_url("/whip")), "0")
                await manager.shutdown()
        finally:
            await server.close()

        self.assertEqual(requests, [
            ("POST", "application/sdp", "Bearer test-secret", "v=0\r\ns=whip-test\r\n"),
            ("DELETE", "Bearer test-secret", "/whip/session/lease"),
        ])

    async def test_rejects_failed_whip_handshake(self):
        async def reject(_request):
            return web.Response(status=401, text="Unauthorized")

        with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
            await self.run_push(reject)

    async def test_ui_connect_disconnect_and_reconnect_use_current_token(self):
        requests = []

        async def receive(request):
            requests.append(("POST", request.headers.get("Authorization")))
            lease = str(len(requests))
            return web.Response(status=201, text="v=0\r\ns=answer\r\n",
                                content_type="application/sdp",
                                headers={"Location": f"/whip/session/{lease}"})

        async def remove(request):
            requests.append(("DELETE", request.headers.get("Authorization")))
            return web.Response(status=204)

        app = web.Application()
        app.router.add_post("/whip", receive)
        app.router.add_delete("/whip/session/{lease}", remove)
        server = TestServer(app)
        await server.start_server()
        manager = rtc_manager.RTCManager(SimpleNamespace())
        sessions = FakeSessions()
        try:
            with patch.object(rtc_manager, "RTCPeerConnection", FakePeerConnection), \
                 patch.object(rtc_manager, "session_manager", sessions), \
                 patch("server.webrtc.HumanPlayer", return_value=SimpleNamespace(audio=object(), video=object())):
                url = str(server.make_url("/whip"))
                await manager.connect_whip(url, "first-secret", "0")
                self.assertEqual(manager.whip_status("0"), {"state": "connected", "url": url})
                old_pc = manager._whip_connections["0"]
                await manager.disconnect_whip("0")
                self.assertEqual(manager.whip_status("0"), {"state": "disconnected", "url": ""})
                await manager.connect_whip(url, "second-secret", "0")
                old_pc.connectionState = "closed"
                await old_pc.handlers["connectionstatechange"]()
                self.assertIn("0", sessions.active)
                self.assertEqual(manager.whip_status("0"), {"state": "connected", "url": url})
                await manager.disconnect_whip("0")
        finally:
            await manager.shutdown()
            await server.close()

        self.assertEqual(requests, [
            ("POST", "Bearer first-secret"),
            ("DELETE", "Bearer first-secret"),
            ("POST", "Bearer second-secret"),
            ("DELETE", "Bearer second-secret"),
        ])


if __name__ == "__main__":
    unittest.main()
