"""Local microphone PCM input for AVTR-1 active listening."""

import ipaddress
from urllib.parse import urlsplit
from uuid import UUID

import numpy as np
from aiohttp import web

from server.session_manager import session_manager


MAX_PCM_BYTES = 32000  # At most one second of mono PCM16 at 16 kHz.


def _local_studio_request(request):
    try:
        peer = ipaddress.ip_address(request.remote or '')
        host = urlsplit(f'http://{request.host}').hostname or ''
        local_host = host == 'localhost' or ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
    origin = request.headers.get('Origin')
    # Electron's file:// renderer sends Origin: null. Session IDs still scope
    # this local-only endpoint to an active avatar connection.
    return peer.is_loopback and local_host and origin in (None, 'null', f'{request.scheme}://{request.host}')


def _valid_session_id(value):
    if value == '0':  # The default WHIP projection session.
        return True
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


async def listen_audio(request):
    if not _local_studio_request(request):
        raise web.HTTPForbidden(text='Local Studio request required')
    session_id = request.query.get('sessionid', '')
    if not _valid_session_id(session_id):
        raise web.HTTPBadRequest(text='Invalid session ID')
    if request.content_type != 'application/octet-stream':
        raise web.HTTPUnsupportedMediaType(text='PCM16 octet-stream required')
    if request.content_length is not None and request.content_length > MAX_PCM_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_PCM_BYTES, actual_size=request.content_length)
    chunks = []
    size = 0
    while chunk := await request.content.read(MAX_PCM_BYTES + 1 - size):
        size += len(chunk)
        if size > MAX_PCM_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_PCM_BYTES, actual_size=size)
        chunks.append(chunk)
    body = b''.join(chunks)
    if not body or len(body) % 2:
        raise web.HTTPBadRequest(text='Expected nonempty 16-bit PCM')
    if getattr(request.app.get('opt'), 'model', None) != 'avtr1':
        raise web.HTTPConflict(text='AVTR-1 is not active')
    session = session_manager.get_session(session_id)
    if session is None:
        raise web.HTTPNotFound(text='Session not found')
    if getattr(getattr(session, 'opt', None), 'model', None) != 'avtr1' or not callable(getattr(session, 'put_listen_audio', None)):
        raise web.HTTPConflict(text='Session does not support AVTR-1 listening')
    pcm = np.frombuffer(body, dtype='<i2').astype(np.float32) / 32768.0
    session.put_listen_audio(pcm)
    return web.json_response({'code': 0, 'msg': 'ok'})
