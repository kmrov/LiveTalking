import io
import signal
import sys
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts import start_qwen_avatar


class StartQwenAvatarTest(unittest.TestCase):
    def test_repeated_termination_is_ignored_during_owned_cleanup(self):
        class Process:
            pid = 123
            def poll(self):
                return None
            def wait(inner, timeout=None):
                self.assertEqual(signal.getsignal(signal.SIGTERM), signal.SIG_IGN)
                self.assertEqual(signal.getsignal(signal.SIGINT), signal.SIG_IGN)
        previous = signal.getsignal(signal.SIGTERM)
        with patch('scripts.start_qwen_avatar.os.killpg'):
            start_qwen_avatar.stop_processes([Process()])
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)

    def test_owned_model_exit_fails_its_stage_and_stops_waiting_for_avatar(self):
        class Process:
            returncode = 7
            def poll(self):
                return self.returncode
        app = unittest.mock.Mock()
        args = start_qwen_avatar.parse_args(['--json-status'])
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'tts.*7'):
            start_qwen_avatar.wait_for_services(args, app, [('tts', Process())])
        app.wait.assert_not_called()
        self.assertIn('"stage": "tts", "state": "failed"', output.getvalue())

    def test_keeps_virtualenv_python_symlink(self):
        python = start_qwen_avatar.ROOT / ".venv/bin/python"
        self.assertEqual(start_qwen_avatar.executable(str(python)), python)

    def test_starts_waits_and_stops_only_owned_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "voice.wav"
            with wave.open(str(reference), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0" * 1600)
            deploy = root / "qwen3_tts.yaml"
            deploy.write_text("stages: []", encoding="utf-8")
            logs = root / "logs"
            logs.mkdir()
            args = [
                "--ref-file", str(reference), "--ref-text", "Образец.",
                "--asr-vllm", sys.executable, "--tts-vllm", sys.executable,
                "--tts-deploy-config", str(deploy),
            ]

            class FakeProcess:
                def __init__(self, pid):
                    self.pid = pid

                def poll(self):
                    return None

                def wait(self, timeout=None):
                    return 0

            processes = [FakeProcess(101), FakeProcess(102), FakeProcess(103)]
            with patch("scripts.start_qwen_avatar.model_status", side_effect=["unavailable", "unavailable", "ready", "ready"]), patch(
                "scripts.start_qwen_avatar.subprocess.Popen", side_effect=processes
            ) as popen, patch("scripts.start_qwen_avatar.tempfile.mkdtemp", return_value=str(logs)), patch(
                "scripts.start_qwen_avatar.os.killpg"
            ) as killpg, redirect_stdout(io.StringIO()):
                result = start_qwen_avatar.main(args)
            self.assertEqual(result, 0)
            self.assertEqual(popen.call_count, 3)
            self.assertEqual(killpg.call_count, 3)
            self.assertEqual([call.args[0] for call in killpg.call_args_list], [103, 102, 101])

    def test_json_status_emits_machine_readable_lifecycle_without_changing_human_output(self):
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "voice.wav"
            with wave.open(str(reference), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0" * 1600)

            class FakeProcess:
                pid = 321

                def poll(self):
                    return None

                def wait(self, timeout=None):
                    return 0

            output = io.StringIO()
            args = ["--json-status", "--external-models", "--ref-file", str(reference), "--ref-text", "Привет"]
            with patch("scripts.start_qwen_avatar.model_status", return_value="ready"), patch(
                "scripts.start_qwen_avatar.subprocess.Popen", return_value=FakeProcess()
            ), patch("scripts.start_qwen_avatar.os.killpg"), redirect_stdout(output):
                self.assertEqual(start_qwen_avatar.main(args), 0)
            lines = output.getvalue().splitlines()
            events = [line.removeprefix("LT_STATUS ") for line in lines if line.startswith("LT_STATUS ")]
            self.assertTrue(events)
            self.assertIn('"stage": "asr"', events[0])
            self.assertTrue(any('"stage": "livetalking"' in event and '"state": "starting"' in event for event in events))
            self.assertIn("Starting LiveTalking", output.getvalue())

    def test_json_status_is_absent_from_normal_dry_run(self):
        args = start_qwen_avatar.parse_args(["--dry-run"])
        self.assertFalse(args.json_status)

    def test_dry_run_builds_all_three_commands_and_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "voice.wav"
            with wave.open(str(reference), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0" * 1600)
            transcript = root / "voice.txt"
            transcript.write_text("Это образец.", encoding="utf-8")
            prompt = root / "role.txt"
            prompt.write_text("Ты ведущий.", encoding="utf-8")
            deploy = root / "qwen3_tts.yaml"
            deploy.write_text("stages: []", encoding="utf-8")
            args = [
                "--dry-run", "--ref-file", str(reference), "--ref-text-file", str(transcript),
                "--llm-prompt-file", str(prompt), "--llm-reasoning-effort", "none", "--asr-vllm", sys.executable,
                "--tts-vllm", sys.executable, "--tts-deploy-config", str(deploy),
                "--", "--transport", "virtualcam",
            ]
            output = io.StringIO()
            with redirect_stdout(output), patch("scripts.start_qwen_avatar.subprocess.Popen") as popen:
                result = start_qwen_avatar.main(args)
            self.assertEqual(result, 0)
            popen.assert_not_called()
            rendered = output.getvalue()
            self.assertIn("Qwen/Qwen3-ASR-0.6B", rendered)
            self.assertIn("Qwen/Qwen3-TTS-12Hz-1.7B-Base", rendered)
            self.assertIn("--llm_system_prompt_file", rendered)
            self.assertIn("--llm_reasoning_effort none", rendered)
            self.assertIn("--transport virtualcam", rendered)
            self.assertIn("Это образец.", rendered)

    def test_missing_reference_transcript_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0")
            args = start_qwen_avatar.parse_args(["--ref-file", str(path)])
            with self.assertRaisesRegex(ValueError, "ref-text"):
                start_qwen_avatar.reference(args)


if __name__ == "__main__":
    unittest.main()
