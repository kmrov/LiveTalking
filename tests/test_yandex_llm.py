import json
import os
import tempfile
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import openai

import llm
from config import parse_args


class YandexLLMTest(unittest.TestCase):
    def test_system_prompt_file_is_loaded_from_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = Path(directory) / "avatar.txt"
            prompt.write_text("Ты ведущий научной передачи.\nГовори спокойно.", encoding="utf-8")
            with patch.object(sys, "argv", ["app.py", "--llm_system_prompt_file", str(prompt)]):
                opt = parse_args()
        self.assertEqual(opt.llm_system_prompt, "Ты ведущий научной передачи.\nГовори спокойно.")

    def test_reasoning_effort_can_be_selected_from_cli(self):
        with patch.object(sys, "argv", ["app.py", "--llm_reasoning_effort", "none"]):
            opt = parse_args()
        self.assertEqual(opt.llm_reasoning_effort, "none")

    def test_custom_system_prompt_is_sent_to_chat_provider(self):
        calls = []
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=lambda **kwargs: calls.append(kwargs) or []
        )))
        avatar = SimpleNamespace(
            opt=SimpleNamespace(llm_provider="dashscope", llm_system_prompt="Ты добрый робот."),
            put_msg_txt=lambda text, info: None,
        )
        with patch.object(llm, "_llm_client", return_value=client):
            llm.llm_response("Привет", avatar)
        self.assertEqual(calls[0]["messages"][0], {"role": "system", "content": "Ты добрый робот."})

    def test_interrupt_prevents_old_llm_stream_from_speaking(self):
        spoken = []
        avatar = SimpleNamespace(
            opt=SimpleNamespace(llm_provider="dashscope", llm_model="test-model"),
            talk_generation=0,
            put_msg_txt=lambda text, info: spoken.append(text),
        )

        def chunks():
            yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Первый ответ."))])
            avatar.talk_generation += 1
            yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Старый второй ответ."))])

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: chunks())))
        with patch.object(llm, "_llm_client", return_value=client):
            llm.llm_response("Вопрос", avatar)
        self.assertEqual(spoken, ["Первый ответ."])

    def test_provider_override_uses_its_own_default_model(self):
        with patch.object(sys, "argv", ["app.py", "--llm_provider", "dashscope"]):
            opt = parse_args()
        self.assertEqual(llm._llm_model(opt), "qwen-plus")

    def test_responses_stream_sends_text_to_avatar(self):
        requests = []
        spoken = []

        def handle(request):
            requests.append(request)
            events = (
                'data: {"type":"response.output_text.delta","delta":"Привет, друг. "}\n\n'
                'data: {"type":"response.output_text.delta","delta":"Как дела?"}\n\n'
                'data: [DONE]\n\n'
            )
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=events)

        real_openai = openai.OpenAI

        def local_client(**kwargs):
            return real_openai(**kwargs, http_client=httpx.Client(transport=httpx.MockTransport(handle)))

        avatar = SimpleNamespace(
            opt=SimpleNamespace(
                llm_provider="yandex",
                llm_project="b1gnot6t4gp0jj7a56du",
                llm_model="gpt://b1gnot6t4gp0jj7a56du/deepseek-v4.1-flash/latest",
                llm_system_prompt="Ты ведущий научной передачи.",
                llm_reasoning_effort="none",
            ),
            put_msg_txt=lambda text, info: spoken.append((text, info)),
        )

        with patch.dict(os.environ, {"YANDEX_AISTUDIO_KEY": "test-key"}), patch(
            "openai.OpenAI", side_effect=local_client
        ):
            llm.llm_response("Поздоровайся", avatar, {"request_id": "one"})

        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(str(request.url), "https://ai.api.cloud.yandex.net/v1/responses")
        self.assertEqual(request.headers["Authorization"], "Api-Key test-key")
        self.assertEqual(request.headers["OpenAI-Project"], "b1gnot6t4gp0jj7a56du")
        payload = json.loads(request.content)
        self.assertEqual(payload["model"], avatar.opt.llm_model)
        self.assertEqual(payload["instructions"], "Ты ведущий научной передачи.")
        self.assertEqual(payload["input"], "Поздоровайся")
        self.assertEqual(payload["temperature"], 0.3)
        self.assertEqual(payload["max_output_tokens"], 1500)
        self.assertEqual(payload["reasoning"], {"effort": "none"})
        self.assertTrue(payload["stream"])
        self.assertEqual("".join(text for text, _ in spoken), "Привет, друг. Как дела?")
        self.assertTrue(all(info == {"request_id": "one"} for _, info in spoken))

    def test_missing_yandex_key_is_rejected(self):
        opt = SimpleNamespace(llm_provider="yandex", llm_project="b1gnot6t4gp0jj7a56du")
        with patch.dict(os.environ, {"YANDEX_AISTUDIO_KEY": "", "OPENAI_API_KEY": "fallback-key"}):
            with self.assertRaisesRegex(ValueError, "YANDEX_AISTUDIO_KEY"):
                llm._llm_client(opt)

    def test_response_failure_event_is_reported(self):
        events = [
            SimpleNamespace(type="response.output_text.delta", delta="Часть ответа"),
            SimpleNamespace(
                type="response.failed",
                response=SimpleNamespace(error=SimpleNamespace(message="model unavailable")),
            ),
        ]
        chunks = llm._yandex_text_chunks(events)
        self.assertEqual(next(chunks), "Часть ответа")
        with self.assertRaisesRegex(RuntimeError, "model unavailable"):
            next(chunks)

    def test_response_error_and_incomplete_events_are_reported(self):
        cases = [
            (SimpleNamespace(type="error", message="request failed"), "request failed"),
            (
                SimpleNamespace(
                    type="response.incomplete",
                    response=SimpleNamespace(incomplete_details=SimpleNamespace(reason="max_output_tokens")),
                ),
                "max_output_tokens",
            ),
        ]
        for event, reason in cases:
            with self.subTest(event=event.type):
                with self.assertRaisesRegex(RuntimeError, reason):
                    list(llm._yandex_text_chunks([event]))


if __name__ == "__main__":
    unittest.main()
