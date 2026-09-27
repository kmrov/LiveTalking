"""The desktop launcher must work without uncommitted local dependencies."""
import sys
import unittest
from unittest.mock import patch

import config
from scripts import start_qwen_avatar


class DesktopLauncherContractTest(unittest.TestCase):
    def test_parser_accepts_generated_launcher_arguments(self):
        args = start_qwen_avatar.parse_args([])
        command = start_qwen_avatar.avatar_command(args, sys.executable, "/tmp/voice.wav", "Привет")
        with patch.object(sys, "argv", command[1:] + ["--config", ""]):
            opt = config.parse_args()
        self.assertEqual(opt.ASR_BACKEND, "qwen3asr")
        self.assertEqual(opt.tts, "qwen3tts")

    def test_microphone_backend_is_available(self):
        from server.qwen3_asr import transcribe_pcm
        self.assertTrue(callable(transcribe_pcm))
