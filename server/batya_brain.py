"""Ordered Batya turns and incremental speech over its stable SSE protocol."""
import asyncio
from collections import OrderedDict
import json
import re
from uuid import UUID, uuid4

import aiohttp


def conversation_id(value):
    if not isinstance(value, str):
        raise ValueError('batya_conversation_id must be a UUID')
    return str(UUID(value)) if value else ''


class BatyaTransport:
    def __init__(self, base_url):
        self.url = base_url.rstrip('/')
        self.client = None

    def session(self):
        if self.client is None:
            self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300, sock_connect=5, sock_read=90))
        return self.client

    async def create_conversation(self):
        async with self.session().post(self.url + '/api/v1/conversations', json={}) as response:
            response.raise_for_status()
            return conversation_id((await response.json())['id'])

    async def events(self, identifier, body):
        async with self.session().post(f'{self.url}/api/v1/conversations/{identifier}/messages', json=body) as response:
            response.raise_for_status()
            if 'text/event-stream' not in response.headers.get('Content-Type', ''):
                raise ValueError('Batya did not return a speech stream')
            event, lines, size = 'message', [], 0
            async for raw in response.content:
                line = raw.decode('utf-8').rstrip('\r\n')
                if not line:
                    if lines:
                        yield event, json.loads('\n'.join(lines))
                    event, lines, size = 'message', [], 0
                elif line.startswith('event:'):
                    event = line[6:].strip()
                elif line.startswith('data:'):
                    data = line[5:].lstrip(' ')
                    size += len(data)
                    if size > 1_000_000:
                        raise ValueError('Batya stream event is too large')
                    lines.append(data)

    async def close(self):
        if self.client is not None:
            await self.client.close()


class PhraseBuffer:
    def __init__(self):
        self.text = ''

    def feed(self, delta, final=False):
        self.text += delta
        phrases = []
        while self.text:
            match = re.search(r'[.!?;\n](?:["»”]*)', self.text)
            end = match.end() if match else 0
            if not end and len(self.text) >= 180:
                end = self.text.rfind(' ', 60, 180)
                if end < 0:
                    end = 180
            if not end:
                if not final:
                    break
                end = len(self.text)
            phrase, self.text = self.text[:end].strip(), self.text[end:]
            if phrase:
                phrases.append(phrase)
        return phrases


class BatyaBrain:
    def __init__(self, base_url, transport=None):
        self.transport = transport or BatyaTransport(base_url)
        self.tails = {}
        self.requests = OrderedDict()
        self.tasks = set()
        self.closed = False

    async def submit(self, avatar, text, request_id=None, datainfo=None, interrupt=False):
        if self.closed:
            raise ValueError('Batya brain is stopped')
        if not isinstance(text, str) or not text.strip() or len(text) > 20_000:
            raise ValueError('Message must contain 1–20000 characters')
        text = text.strip()
        request_id = str(uuid4()) if request_id is None else request_id
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
            raise ValueError('request_id must contain 1–200 characters')
        if not hasattr(avatar, '_batya_lock'):
            avatar._batya_lock = asyncio.Lock()
        async with avatar._batya_lock:
            identifier = conversation_id(getattr(avatar.opt, 'batya_conversation_id', ''))
            if not identifier:
                identifier = await self.transport.create_conversation()
                avatar.opt.batya_conversation_id = identifier
        accepted = {'conversation_id': identifier, 'request_id': request_id}
        key = (identifier, request_id)
        if key in self.requests:
            if self.requests[key][0] != text:
                raise ValueError('request_id already used with different text')
            return accepted
        if interrupt:
            avatar.flush_talk()
        generation = getattr(avatar, 'talk_generation', 0)
        previous = self.tails.get(identifier)
        avatar.batya_pending = getattr(avatar, 'batya_pending', 0) + 1
        self.emit(avatar, 'queued', accepted, pending=avatar.batya_pending)
        task = asyncio.create_task(self.run(previous, avatar, text, accepted, generation, datainfo or {}))
        self.requests[key] = (text, task)
        self.tails[identifier] = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        # Keep active work plus a bounded recent duplicate-request cache.
        for cached, (_, job) in list(self.requests.items()):
            if len(self.requests) <= 256:
                break
            if job.done():
                self.requests.pop(cached)
        return accepted

    @staticmethod
    def emit(avatar, event, accepted, **fields):
        avatar.send_msg(json.dumps({'brain': 'batya', 'event': event, **accepted, **fields}, ensure_ascii=False))

    @staticmethod
    def may_speak(avatar, generation):
        quitting = getattr(avatar, 'quit_event', None)
        return getattr(avatar, 'talk_generation', 0) == generation and not (quitting and quitting.is_set())

    async def run(self, previous, avatar, text, accepted, generation, datainfo):
        try:
            if previous:
                await previous
            self.emit(avatar, 'thinking', accepted)
            buffer, received = PhraseBuffer(), ''
            done = False
            body = {'text': text, 'request_id': accepted['request_id'], 'stream': True, 'speech_stream': True}
            for attempt in range(2):
                replay, prefix = '', received
                try:
                    async for event, data in self.transport.events(accepted['conversation_id'], body):
                        if event == 'delta':
                            delta = data.get('text')
                            if not isinstance(delta, str):
                                raise ValueError('Invalid Batya delta')
                            replay += delta
                            if prefix.startswith(replay):
                                continue
                            if not replay.startswith(prefix):
                                raise ValueError('Batya retry returned a different answer; speech stopped')
                            fresh = replay[len(received):]
                            received = replay
                            if fresh:
                                self.emit(avatar, 'delta', accepted, text=fresh)
                                for phrase in buffer.feed(fresh):
                                    if self.may_speak(avatar, generation):
                                        avatar.put_msg_txt(phrase, {**datainfo, **accepted})
                        elif event == 'done':
                            final = data.get('text')
                            if not isinstance(final, str) or not final.strip() or final.strip() != received.strip():
                                raise ValueError('Batya final answer differs from its speech stream')
                            for phrase in buffer.feed('', final=True):
                                if self.may_speak(avatar, generation):
                                    avatar.put_msg_txt(phrase, {**datainfo, **accepted})
                            done = True
                            self.emit(avatar, 'done', accepted, text=final, speech_suppressed=not self.may_speak(avatar, generation))
                            break
                        elif event == 'reset':
                            raise ValueError('Batya speech protocol reset: update Batya before retrying')
                        elif event == 'error':
                            raise ValueError(f"Batya generation error: {data.get('code', 'generation_failed')}")
                    if not done:
                        raise ConnectionError('Batya stream ended without done')
                    break
                except (aiohttp.ClientError, TimeoutError, ConnectionError):
                    if attempt:
                        raise
                    self.emit(avatar, 'retrying', accepted)
        except asyncio.CancelledError:
            if self.may_speak(avatar, generation):
                avatar.flush_talk()
            raise
        except Exception as error:
            self.requests.pop((accepted['conversation_id'], accepted['request_id']), None)
            if self.may_speak(avatar, generation):
                avatar.flush_talk()
            self.emit(avatar, 'error', accepted, message=str(error))
        finally:
            avatar.batya_pending = max(0, getattr(avatar, 'batya_pending', 1) - 1)
            self.emit(avatar, 'idle', accepted, pending=avatar.batya_pending)

    async def wait_idle(self):
        while self.tasks:
            await asyncio.gather(*list(self.tasks))

    async def close(self):
        self.closed = True
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        await self.transport.close()
