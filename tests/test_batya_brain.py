import asyncio
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from server.batya_brain import BatyaBrain


class Avatar:
    def __init__(self, conversation_id=''):
        self.opt = SimpleNamespace(batya_conversation_id=conversation_id)
        self.talk_generation = 0
        self.events, self.speech = [], []
    def send_msg(self, value):
        self.events.append(json.loads(value))
    def put_msg_txt(self, text, data):
        self.speech.append(text)
    def flush_talk(self):
        self.talk_generation += 1
        self.speech.clear()


class Transport:
    def __init__(self):
        self.id = str(uuid4())
        self.calls, self.created = [], 0
        self.started, self.release = asyncio.Event(), asyncio.Event()
    async def create_conversation(self):
        self.created += 1
        return self.id
    async def events(self, conversation_id, body):
        self.calls.append((conversation_id, body.copy()))
        yield 'delta', {'text': 'Привет, сынок. '}
        self.started.set()
        await self.release.wait()
        yield 'delta', {'text': 'Как дела?'}
        yield 'done', {'text': 'Привет, сынок. Как дела?'}
    async def close(self):
        pass


class BatyaBrainTest(unittest.IsolatedAsyncioTestCase):
    async def test_duplicate_network_retry_does_not_interrupt_original_turn(self):
        transport, avatar = Transport(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(avatar, 'Привет', 'one', interrupt=True)
        await transport.started.wait()
        generation = avatar.talk_generation
        await brain.submit(avatar, 'Привет', 'one', interrupt=True)
        self.assertEqual(avatar.talk_generation, generation)
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Привет, сынок.', 'Как дела?'])
        await brain.close()

    async def test_failed_turn_can_be_retried_with_the_same_request_id(self):
        class FailingOnce(Transport):
            async def events(self, identifier, body):
                self.calls.append((identifier, body.copy()))
                if len(self.calls) == 1:
                    yield 'error', {'code': 'generation_failed'}
                else:
                    yield 'delta', {'text': 'Получилось.'}
                    yield 'done', {'text': 'Получилось.'}
        transport, avatar = FailingOnce(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(avatar, 'Привет', 'one')
        await brain.wait_idle()
        await brain.submit(avatar, 'Привет', 'one')
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Получилось.'])
        await brain.close()
    async def test_streamed_phrase_is_spoken_before_done_and_final_is_not_duplicated(self):
        transport, avatar = Transport(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        accepted = await brain.submit(avatar, 'Привет', 'one')
        await transport.started.wait()
        self.assertEqual(avatar.speech, ['Привет, сынок.'])
        self.assertFalse(any(e['event'] == 'done' for e in avatar.events))
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Привет, сынок.', 'Как дела?'])
        self.assertTrue(transport.calls[0][1]['speech_stream'])
        self.assertEqual(accepted['conversation_id'], avatar.opt.batya_conversation_id)
        await brain.close()

    async def test_interrupt_suppresses_old_audio_and_shared_conversation_turns_are_ordered(self):
        transport, first = Transport(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(first, 'Первый', 'one')
        await transport.started.wait()
        first.flush_talk()
        second = Avatar(transport.id)
        await brain.submit(second, 'Второй', 'two')
        self.assertEqual(len(transport.calls), 1)
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(first.speech, [])
        self.assertEqual(second.speech, ['Привет, сынок.', 'Как дела?'])
        self.assertEqual([call[1]['request_id'] for call in transport.calls], ['one', 'two'])
        await brain.close()

    async def test_duplicate_request_is_shared_and_conflicting_text_is_rejected(self):
        transport, avatar = Transport(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        accepted = await brain.submit(avatar, 'Привет', 'one')
        self.assertEqual(await brain.submit(avatar, 'Привет', 'one'), accepted)
        with self.assertRaisesRegex(ValueError, 'request_id'):
            await brain.submit(avatar, 'Другой текст', 'one')
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.created, 1)
        await brain.close()

    async def test_transport_retry_reuses_id_and_suppresses_replayed_prefix(self):
        class Retrying(Transport):
            async def events(self, conversation_id, body):
                self.calls.append((conversation_id, body.copy()))
                if len(self.calls) == 1:
                    yield 'delta', {'text': 'Привет, сынок. '}
                    raise ConnectionError('stream interrupted')
                yield 'delta', {'text': 'Привет, '}
                yield 'delta', {'text': 'сынок. Как дела?'}
                yield 'done', {'text': 'Привет, сынок. Как дела?'}
        transport, avatar = Retrying(), Avatar()
        brain = BatyaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(avatar, 'Привет', 'one')
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Привет, сынок.', 'Как дела?'])
        self.assertEqual([call[1]['request_id'] for call in transport.calls], ['one', 'one'])
        await brain.close()

    async def test_reset_error_and_missing_done_fail_visibly_and_clear_speech(self):
        for failure in ['reset', 'error', 'eof']:
            class Failing(Transport):
                async def events(self, conversation_id, body):
                    yield 'delta', {'text': 'Первое предложение. '}
                    if failure != 'eof':
                        yield failure, {'code': 'generation_failed'}
            avatar = Avatar()
            brain = BatyaBrain('http://127.0.0.1:8000', transport=Failing())
            await brain.submit(avatar, 'Привет')
            await brain.wait_idle()
            self.assertEqual(avatar.speech, [], failure)
            self.assertTrue(any(e['event'] == 'error' for e in avatar.events), failure)
            await brain.close()
