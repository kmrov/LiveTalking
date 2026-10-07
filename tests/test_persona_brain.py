import asyncio
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from server.persona_brain import PersonaBrain, PhraseBuffer


class PhraseBufferTest(unittest.TestCase):
    def test_first_speech_phrase_starts_at_an_early_clause(self):
        buffer = PhraseBuffer()
        self.assertEqual(buffer.feed('Ну, сейчас я расскажу тебе кое-что важное,'),
                         ['Ну, сейчас я расскажу тебе кое-что важное,'])
        self.assertEqual(buffer.feed(' а потом объясню остальные детали.'),
                         ['а потом объясню остальные детали.'])

    def test_first_long_sentence_starts_before_its_final_punctuation(self):
        buffer = PhraseBuffer()
        text = ('Сейчас я расскажу тебе кое-что важное и затем постепенно объясню '
                'каждую из оставшихся деталей без спешки')
        phrases = buffer.feed(text[:75])
        self.assertEqual(len(phrases), 1)
        self.assertGreaterEqual(len(phrases[0]), 45)
        self.assertFalse(phrases[0].endswith(' '))
        rest = buffer.feed(text[75:], final=True)
        self.assertEqual(' '.join(phrases + rest), text)

    def test_emits_a_complete_clause_before_waiting_for_long_sentence(self):
        buffer = PhraseBuffer()
        text = ('Когда модель уже выдаёт первые слова ответа, мы можем начать синтез речи, '
                'пока оставшаяся часть предложения ещё продолжает поступать из модели')
        phrases = buffer.feed(text[:90])
        self.assertEqual(phrases, ['Когда модель уже выдаёт первые слова ответа,'])
        self.assertEqual(buffer.feed(text[90:]), [])
        self.assertEqual(''.join(phrases) + buffer.text, text)


class Avatar:
    def __init__(self, conversation_id=''):
        self.opt = SimpleNamespace(persona_conversation_id=conversation_id)
        self.talk_generation = 0
        self.events, self.speech = [], []
        self.msgqueues = []
    def send_msg(self, value):
        self.events.append(json.loads(value))
        for queue in self.msgqueues:
            queue.put(value)
    def add_msgqueue(self, queue):
        self.msgqueues.append(queue)
    def put_msg_txt(self, text, data):
        self.speech.append(text)
    def flush_talk(self):
        self.talk_generation += 1
        self.speech.clear()
    def clear_speech(self):
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


class PersonaBrainTest(unittest.IsolatedAsyncioTestCase):
    async def test_generation_error_exposes_bridge_detail(self):
        class Failing(Transport):
            async def events(self, conversation_id, body):
                yield 'error', {'code': 'generation_failed',
                                'message': 'The character prompt exceeds the selected model context.'}
        avatar = Avatar()
        brain = PersonaBrain('http://127.0.0.1:8000', transport=Failing())
        await brain.submit(avatar, 'Привет')
        await brain.wait_idle()
        error = next(event for event in avatar.events if event['event'] == 'error')
        self.assertIn('character prompt exceeds', error['message'])
        await brain.close()

    async def test_reconnect_restores_pending_turn_and_receives_completion_without_speaking(self):
        transport, original = Transport(), Avatar()
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(original, 'Привет', 'one')
        await transport.started.wait()
        original.flush_talk()
        reconnected, events = Avatar(transport.id), []
        unsubscribe = brain.subscribe(reconnected, lambda data: events.append(json.loads(data)))
        snapshot = events[0]
        self.assertEqual(snapshot['event'], 'snapshot')
        self.assertEqual(snapshot['text'], 'Привет, сынок. ')
        self.assertEqual(snapshot['user_text'], 'Привет')
        self.assertEqual(snapshot['pending'], 1)
        self.assertEqual(brain.pending(reconnected), 1)
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual([e['event'] for e in events], ['snapshot', 'delta', 'done', 'idle'])
        self.assertEqual(events[-1]['pending'], 0)
        self.assertEqual(reconnected.speech, [])
        self.assertEqual(sum(e['event'] == 'done' for e in original.events), 1)
        unsubscribe()
        # Completion between history fetch and SSE subscription must also replay.
        late = []
        unsubscribe = brain.subscribe(reconnected, lambda data: late.append(json.loads(data)))
        self.assertEqual(late[0]['status'], 'done')
        self.assertEqual(late[0]['text'], 'Привет, сынок. Как дела?')
        self.assertEqual(late[0]['pending'], 0)
        unsubscribe()
        self.assertEqual(len(brain.listeners), 0)
        await brain.close()

    async def test_error_cleanup_preserves_speech_of_a_queued_uninterrupted_turn(self):
        class FailingFirst(Transport):
            async def events(self, identifier, body):
                self.calls.append((identifier, body.copy()))
                if body['request_id'] == 'one':
                    yield 'delta', {'text': 'Старое.'}
                    self.started.set()
                    await self.release.wait()
                    yield 'error', {'code': 'generation_failed'}
                else:
                    yield 'delta', {'text': 'Следующее.'}
                    yield 'done', {'text': 'Следующее.'}
        transport, avatar = FailingFirst(), Avatar()
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(avatar, 'Первый', 'one')
        await transport.started.wait()
        await brain.submit(avatar, 'Второй', 'two')
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Следующее.'])
        done = next(e for e in avatar.events if e['event'] == 'done')
        self.assertFalse(done['speech_suppressed'])
        await brain.close()

    async def test_duplicate_network_retry_does_not_interrupt_original_turn(self):
        transport, avatar = Transport(), Avatar()
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
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
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
        await brain.submit(avatar, 'Привет', 'one')
        await brain.wait_idle()
        await brain.submit(avatar, 'Привет', 'one')
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Получилось.'])
        await brain.close()
    async def test_streamed_phrase_is_spoken_before_done_and_final_is_not_duplicated(self):
        transport, avatar = Transport(), Avatar()
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
        accepted = await brain.submit(avatar, 'Привет', 'one')
        await transport.started.wait()
        self.assertEqual(avatar.speech, ['Привет, сынок.'])
        self.assertFalse(any(e['event'] == 'done' for e in avatar.events))
        transport.release.set()
        await brain.wait_idle()
        self.assertEqual(avatar.speech, ['Привет, сынок.', 'Как дела?'])
        self.assertTrue(transport.calls[0][1]['speech_stream'])
        self.assertEqual(accepted['conversation_id'], avatar.opt.persona_conversation_id)
        await brain.close()

    async def test_interrupt_suppresses_old_audio_and_shared_conversation_turns_are_ordered(self):
        transport, first = Transport(), Avatar()
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
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
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
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
        brain = PersonaBrain('http://127.0.0.1:8000', transport=transport)
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
            brain = PersonaBrain('http://127.0.0.1:8000', transport=Failing())
            await brain.submit(avatar, 'Привет')
            await brain.wait_idle()
            self.assertEqual(avatar.speech, [], failure)
            self.assertTrue(any(e['event'] == 'error' for e in avatar.events), failure)
            await brain.close()
