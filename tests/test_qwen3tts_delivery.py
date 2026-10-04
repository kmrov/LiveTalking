"""Qwen delivery keeps the producer generation until the avatar accepts PCM."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from tts.base_tts import State
from tts.qwen3tts import Qwen3TTS


class QwenDeliveryTests(unittest.TestCase):
    def tts(self, parent):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        reference = Path(directory.name) / 'voice.wav'
        reference.write_bytes(b'RIFF-example')
        opt = SimpleNamespace(fps=25, REF_FILE=str(reference), REF_TEXT='Sample',
                              TTS_SERVER='http://localhost:8091')
        return Qwen3TTS(opt, parent)

    def response(self):
        # 530 samples at 24 kHz produce one whole packet and a padded tail.
        return SimpleNamespace(raise_for_status=lambda: None,
            iter_content=lambda chunk_size: iter([np.full(530, 8000, '<i2').tobytes()]),
            close=lambda: None)

    def test_all_packets_including_padded_tail_and_end_carry_captured_generation(self):
        packets = []
        parent = SimpleNamespace(
            put_audio_frame=lambda *_: self.fail('Generation-aware parent must receive every packet'),
            put_tts_audio_frame=lambda audio, event, producer, generation:
                packets.append((audio.copy(), event, producer, generation)))
        tts = self.tts(parent)
        tts._generation = 7
        with patch('tts.qwen3tts.requests.post', return_value=self.response()):
            tts.txt_to_audio(('Speech', {'request_id': 'r'}))
        self.assertEqual(len(packets), 3)
        self.assertTrue(all(producer is tts and generation == 7 for _, _, producer, generation in packets))
        self.assertTrue(all(audio.shape == (320,) for audio, *_ in packets))
        self.assertTrue(packets[0][0].any())
        self.assertTrue(packets[1][0].any())
        self.assertEqual(packets[1][0][-1], 0)
        self.assertEqual(packets[0][1]['status'], 'start')
        self.assertEqual(packets[-1][1], {'request_id': 'r', 'status': 'end', 'text': 'Speech'})
        self.assertFalse(packets[-1][0].any())

    def test_interrupt_between_tts_check_and_delivery_retains_old_producer_generation(self):
        attempted, accepted = [], []
        def deliver(audio, event, producer, generation):
            if not attempted:
                producer.flush_talk()
            attempted.append(generation)
            if producer._generation == generation:
                accepted.append(event)
        tts = self.tts(SimpleNamespace(put_tts_audio_frame=deliver,
            put_audio_frame=lambda *_: self.fail('Delivery bypassed generation check')))
        with patch('tts.qwen3tts.requests.post', side_effect=lambda *a, **k: self.response()):
            tts.txt_to_audio(('Old speech', {}))
            self.assertEqual(attempted, [0, 0])
            self.assertEqual(accepted, [])
            tts.state = State.RUNNING
            tts.txt_to_audio(('New speech', {}))
        self.assertEqual(attempted, [0, 0, 1, 1, 1])
        self.assertEqual(accepted[-1]['status'], 'end')
        self.assertEqual(accepted[-1]['text'], 'New speech')

    def test_legacy_parent_receives_audio_and_final_marker(self):
        packets = []
        tts = self.tts(SimpleNamespace(put_audio_frame=lambda audio, event: packets.append((audio,event))))
        with patch('tts.qwen3tts.requests.post', return_value=self.response()):
            tts.txt_to_audio(('Legacy speech', {}))
        self.assertEqual(len(packets), 3)
        self.assertEqual(packets[-1][1]['status'], 'end')


if __name__ == '__main__':
    unittest.main()
