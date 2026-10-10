import threading
import time
import unittest
import numpy as np

from avatars.generative.audio_buffer import AudioBuffer, ListeningAudio


class AudioBufferTests(unittest.TestCase):
    def test_future_audio_peeks_without_consuming_and_pads_only_after_end(self):
        buffer = AudioBuffer()
        for value in range(12):
            buffer.put_audio_frame(np.full(320, value / 20, np.float32),
                                   {'status': 'end'} if value == 11 else {})
        generation, current = buffer.take(5, threading.Event())
        future = buffer.peek_future(3280, generation, threading.Event())
        self.assertEqual(future.shape, (3280,))
        self.assertAlmostEqual(float(future[0]), 5 / 20)
        self.assertAlmostEqual(float(future[6 * 320]), 11 / 20)
        self.assertEqual(float(future[-1]), 0)
        self.assertEqual(buffer.take(1, threading.Event())[1][0].position, 1600)

    def test_listening_audio_bounded_snapshot_and_fresh_block(self):
        listen = ListeningAudio()
        listen.push(np.full(3200, .25, np.float32))
        self.assertTrue(listen.has_block())
        first = listen.snapshot(6480)
        self.assertEqual(first.shape, (6480,))
        self.assertEqual(float(first[-1]), .25)
        listen.mark_rendered()
        self.assertFalse(listen.has_block())
        listen.push(np.full(3200, .5, np.float32))
        self.assertTrue(listen.has_block())
        self.assertEqual(float(listen.snapshot(6480)[-1]), .5)
        listen.push(np.full(3200, .75, np.float32))
        listen.mark_rendered()
        self.assertTrue(listen.has_block(), 'microphone PCM received during GPU render must remain pending')
        listen.snapshot(6480)
        listen.mark_rendered()
        np.testing.assert_equal(listen.snapshot(6480), 0,
                                'an old microphone window must not be replayed after capture stops')

    def test_streaming_waits_through_tts_gap_without_padding(self):
        buffer = AudioBuffer()
        quit_event = threading.Event()
        result = []
        buffer.put_audio_frame(np.full(320, .25, np.float32), {'status': 'start'})
        thread = threading.Thread(target=lambda: result.append(buffer.take(4, quit_event, gap_timeout=None)))
        thread.start()
        self.addCleanup(lambda: (quit_event.set(), thread.join(1)))
        time.sleep(.25)
        self.assertTrue(thread.is_alive(), 'A streaming TTS gap is not the end of speech')
        buffer.put_audio_frame(np.full(320, .5, np.float32), {})
        buffer.put_audio_frame(np.zeros(320, np.float32), {'status': 'end'})
        thread.join(1)
        self.assertFalse(thread.is_alive())
        _, packets = result[0]
        self.assertEqual([p.type for p in packets], [0, 0, 0, 1])
        self.assertEqual(float(packets[1].data[0]), .5)

    def test_waiting_streaming_batch_stops_when_session_closes(self):
        buffer = AudioBuffer()
        quit_event = threading.Event()
        result = []
        buffer.put_audio_frame(np.ones(320, np.float32), {})
        thread = threading.Thread(target=lambda: result.append(buffer.take(4, quit_event, gap_timeout=None)), daemon=True)
        thread.start()
        self.addCleanup(lambda: (quit_event.set(), buffer.put_audio_frame(np.zeros(320, np.float32), {'status':'end'}), thread.join(1)))
        time.sleep(.1)
        quit_event.set()
        thread.join(.3)
        self.assertFalse(thread.is_alive(), 'Session close must not leave a blocked audio collector')
        self.assertEqual(result, [None])

    def test_short_utterance_keeps_events_and_pads_tail(self):
        buffer = AudioBuffer()
        buffer.put_audio_frame(np.ones(320, np.float32), {'status': 'start'})
        buffer.put_audio_frame(np.full(320, .5, np.float32), {'status': 'end'})
        generation, packets = buffer.take(4, threading.Event())
        self.assertEqual(generation, 0)
        self.assertEqual([p.type for p in packets], [0, 0, 1, 1])
        self.assertEqual(packets[0].userdata['status'], 'start')
        self.assertEqual(packets[1].userdata['status'], 'end')
        np.testing.assert_equal(packets[1].data, .5)
        np.testing.assert_equal(packets[-1].data, 0)

    def test_interrupt_invalidates_collected_audio_and_keeps_new_generation(self):
        buffer = AudioBuffer()
        buffer.put_audio_frame(np.ones(320), {})
        old = buffer.take(2, threading.Event(), gap_timeout=0)[0]
        buffer.flush_talk()
        buffer.put_audio_frame(np.full(320, .25), {'status': 'end'})
        new, packets = buffer.take(2, threading.Event())
        self.assertNotEqual(old, buffer.generation)
        self.assertEqual(new, buffer.generation)
        self.assertEqual(float(packets[0].data[0]), .25)

    def test_audio_is_copied_and_invalid_length_rejected(self):
        buffer = AudioBuffer()
        audio = np.ones(320, np.float32)
        buffer.put_audio_frame(audio, {})
        audio[:] = 0
        self.assertEqual(float(buffer.take(1, threading.Event())[1][0].data[0]), 1)
        with self.assertRaises(ValueError):
            buffer.put_audio_frame(np.zeros(300), {})

    def test_playback_receives_every_real_packet_in_order_with_sample_positions(self):
        buffer = AudioBuffer()
        for value in (1, 2, 3):
            buffer.put_audio_frame(np.full(320, value, np.float32), {})
        _, inferred = buffer.take(3, threading.Event())
        played = [buffer.pop_playback() for _ in range(3)]
        self.assertEqual([packet.position for packet in inferred], [0, 320, 640])
        self.assertEqual([packet.position for _, packet in played], [0, 320, 640])
        self.assertEqual([float(packet.data[0]) for _, packet in played], [1, 2, 3])
        self.assertIsNone(buffer.pop_playback())

    def test_interrupt_discards_old_playback_and_restarts_position(self):
        buffer = AudioBuffer()
        buffer.put_audio_frame(np.ones(320, np.float32), {'turn': 'old'})
        buffer.flush_talk()
        self.assertIsNone(buffer.pop_playback())
        buffer.put_audio_frame(np.full(320, 2, np.float32), {'turn': 'new'})
        generation, packet = buffer.pop_playback()
        self.assertEqual(generation, buffer.generation)
        self.assertEqual((packet.position, packet.userdata['turn']), (0, 'new'))


if __name__ == '__main__':
    unittest.main()
