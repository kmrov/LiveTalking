###############################################################################
#  WebRTC 连接管理 + RTC 音频/视频接收
###############################################################################

import json
import asyncio
import random
import copy
import os
from typing import Dict, Optional
import queue
from urllib.parse import urljoin

import aiohttp
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceServer, RTCConfiguration
from aiortc.rtcrtpsender import RTCRtpSender

from utils.logger import logger


# def _rand_session_id(n: int = 6) -> int:
#     """生成 N 位随机 session ID"""
#     return random.randint(10 ** (n - 1), 10 ** n - 1)


from server.session_manager import session_manager
from server.session_manager import MaxSessionError

class WhipAlreadyActiveError(RuntimeError):
    pass

class RTCManager:
    """
    WebRTC 连接管理器。
    
    管理 PeerConnection 生命周期、音视频轨道收发、DataChannel。
    """

    def __init__(self, opt):
        """
        Args:
            opt: 全局配置
        """
        self.opt = opt
        self.pcs: set = set()
        self._whip_sessions: dict = {}
        self._whip_connections: dict = {}
        self._whip_targets: dict = {}
        self._whip_connecting: set = set()
        self._whip_lock = asyncio.Lock()

    def whip_status(self, sessionid: str = "0"):
        pc = self._whip_connections.get(sessionid)
        if pc is not None:
            return {"state": pc.connectionState, "url": self._whip_targets[sessionid]}
        if sessionid in self._whip_connecting:
            return {"state": "connecting", "url": ""}
        return {"state": "disconnected", "url": ""}

    async def connect_whip(self, push_url: str, token: str, sessionid: str = "0"):
        async with self._whip_lock:
            if sessionid in self._whip_connections or sessionid in self._whip_connecting:
                raise WhipAlreadyActiveError("WHIP session is already active")
            self._whip_connecting.add(sessionid)
            try:
                await self.handle_rtcpush(push_url, sessionid, token=token)
            finally:
                self._whip_connecting.discard(sessionid)
            return self.whip_status(sessionid)

    async def disconnect_whip(self, sessionid: str = "0"):
        async with self._whip_lock:
            pc = self._whip_connections.pop(sessionid, None)
            self._whip_targets.pop(sessionid, None)
            if pc is None:
                return self.whip_status(sessionid)
            await self._delete_whip_session(pc)
            await pc.close()
            self.pcs.discard(pc)
            session_manager.remove_session(sessionid)
            return self.whip_status(sessionid)

    async def _create_pc_and_answer(self, avatar_session, sessionid, offer):
        """创建 PeerConnection、添加轨道、SDP 交换，返回已完成 answer 的 pc"""
        ice_server = RTCIceServer(urls=self.opt.stun)
        pc = RTCPeerConnection(
            configuration=RTCConfiguration(iceServers=[ice_server])
        )
        self.pcs.add(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info("Connection state is %s", pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await pc.close()
                self.pcs.discard(pc)
                session_manager.remove_session(sessionid)

        # 添加发送轨道
        from server.webrtc import HumanPlayer
        player = HumanPlayer(avatar_session)
        pc.addTrack(player.audio)
        pc.addTrack(player.video)

        # 设置编解码器偏好
        capabilities = RTCRtpSender.getCapabilities("video")
        preferences = list(filter(lambda x: x.name == "H264", capabilities.codecs))
        preferences += list(filter(lambda x: x.name == "VP8", capabilities.codecs))
        preferences += list(filter(lambda x: x.name == "rtx", capabilities.codecs))
        transceiver = pc.getTransceivers()[1]
        transceiver.setCodecPreferences(preferences)

        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        return pc

    async def handle_offer(self, request):
        """处理 WebRTC offer 信令"""
        params = await request.json()
        offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

        try:
            sessionid = await session_manager.create_session(params)
        except MaxSessionError as e:
            logger.warning("Rejecting offer: %s", e)
            return web.Response(
                content_type="application/json",
                text=json.dumps({"code": -1, "msg": str(e)}),
            )
        logger.info('offer sessionid=%s', sessionid)

        pc = await self._create_pc_and_answer(
            session_manager.get_session(sessionid), sessionid, offer
        )

        return web.Response(
            content_type="application/json",
            text=json.dumps({
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type,
                "sessionid": sessionid,
            }),
        )

    async def handle_whep(self, request):
        """
        处理 WHEP 信令（WebRTC HTTP Egress Protocol）

        - 请求 body 为裸 SDP offer（Content-Type: application/sdp）
        - 扩展参数通过 query string 传入（avatar, tts, tts_server 等）
        - 返回 SDP answer（Content-Type: application/sdp）
        - sessionid 通过 X-Session-ID 响应头返回
        """
        params = dict(request.query)
        # 客户端可通过 query param 自定义 sessionid，不传则自动生成
        client_sid = params.pop("sessionid", None)

        offer_sdp = await request.text()
        offer = RTCSessionDescription(sdp=offer_sdp, type="offer")

        try:
            sessionid = await session_manager.create_session(params, sessionid=client_sid)
        except MaxSessionError as e:
            logger.warning("Rejecting whep: %s", e)
            return web.Response(
                status=503,
                content_type="text/plain",
                text=str(e),
            )
        logger.info("whep sessionid=%s", sessionid)

        pc = await self._create_pc_and_answer(
            session_manager.get_session(sessionid), sessionid, offer
        )

        return web.Response(
            status=201,
            content_type="application/sdp",
            text=pc.localDescription.sdp,
            headers={"X-Session-ID": sessionid},
        )

    async def handle_rtcpush(self, push_url, sessionid: str, token: Optional[str] = None):
        """RTCPush 模式：主动推流"""
        await session_manager.create_session({}, sessionid)
        avatar_session = session_manager.get_session(sessionid)

        pc = RTCPeerConnection()
        self.pcs.add(pc)
        self._whip_connections[sessionid] = pc
        self._whip_targets[sessionid] = push_url

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info("Connection state is %s", pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await self._delete_whip_session(pc)
                if pc.connectionState != "closed":
                    await pc.close()
                self.pcs.discard(pc)
                if self._whip_connections.get(sessionid) is pc:
                    self._whip_connections.pop(sessionid, None)
                    self._whip_targets.pop(sessionid, None)
                    session_manager.remove_session(sessionid)

        from server.webrtc import HumanPlayer
        player = HumanPlayer(avatar_session)
        pc.addTrack(player.audio)
        pc.addTrack(player.video)

        try:
            await pc.setLocalDescription(await pc.createOffer())
            token = os.getenv("WHIP_BEARER_TOKEN", "").strip() if token is None else token.strip()
            headers = {"Content-Type": "application/sdp"}
            if token:
                headers["Authorization"] = f"Bearer {token}"

            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
                async with session.post(push_url, data=pc.localDescription.sdp, headers=headers) as response:
                    if response.status != 201:
                        raise RuntimeError(f"WHIP POST failed: HTTP {response.status}")
                    answer_sdp = await response.text()
                    location = response.headers.get("Location")
                    if not location:
                        raise RuntimeError("WHIP response missing Location header")
                    self._whip_sessions[pc] = (urljoin(push_url, location), token)

            await pc.setRemoteDescription(
                RTCSessionDescription(sdp=answer_sdp, type='answer')
            )
        except Exception:
            await self._delete_whip_session(pc)
            await pc.close()
            self.pcs.discard(pc)
            if self._whip_connections.get(sessionid) is pc:
                self._whip_connections.pop(sessionid, None)
                self._whip_targets.pop(sessionid, None)
            session_manager.remove_session(sessionid)
            raise

    async def _delete_whip_session(self, pc):
        session_info = self._whip_sessions.pop(pc, None)
        if not session_info:
            return
        session_url, token = session_info
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.delete(session_url, headers=headers) as response:
                    if response.status not in (200, 204, 404):
                        logger.warning("WHIP DELETE failed: HTTP %s", response.status)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            logger.warning("WHIP DELETE failed: %s", exc)

    async def shutdown(self):
        """关闭所有 PeerConnection"""
        for sessionid in list(self._whip_connections):
            await self.disconnect_whip(sessionid)
        await asyncio.gather(*(self._delete_whip_session(pc) for pc in list(self._whip_sessions)))
        coros = [pc.close() for pc in self.pcs]
        await asyncio.gather(*coros)
        self.pcs.clear()
