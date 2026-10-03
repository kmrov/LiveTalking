# Голосовой аватар: Qwen3-ASR + Qwen3-TTS

Этот сценарий использует браузерный микрофон, локальный Qwen3-ASR для русского текста, настроенный LLM и Qwen3-TTS Base для голоса аватара. Сейчас распознавание выполняется **после нажатия «Стоп»**. Чтобы прервать текущий ответ, нажмите «Начать» для новой записи: воспроизведение останавливается сразу, а после «Стоп» новая расшифровка запускает ответ.

## Единый запуск

В этом рабочем каталоге скрипт сам находит vLLM для ASR в `../.venv`, vLLM-Omni для TTS в `../.venv-omni` и уже загруженные веса в `../.hf-cache-qwen`. Запустите из каталога `LiveTalking`:

```bash
.venv/bin/python scripts/start_qwen_avatar.py \
  --ref-file /путь/к/своему/voice.wav \
  --ref-text-file /путь/к/своему/voice.txt \
  --llm-prompt-file prompts/avatar_ru.example.txt
```

Скрипт запустит оба сервера моделей, дождётся их готовности и затем запустит LiveTalking. Если серверы с нужными моделями уже работают, он подключится к ним. `Ctrl+C` остановит только процессы, которые запустил скрипт; их логи сохранятся в указанном при запуске каталоге `/tmp/livetalking-qwen-*`. Для других окружений укажите `--asr-vllm` и `--tts-vllm`. Для удалённых уже запущенных моделей используйте `--external-models --asr-server URL --tts-server URL`. Дополнительные параметры LiveTalking передаются после `--`, например `-- --transport virtualcam`.

Роль и манера ответа задаются UTF-8 файлом через `--llm-prompt-file`. Файл [avatar_ru.example.txt](../prompts/avatar_ru.example.txt) служит примером; можно заменить его своим. В обычном запуске без общего скрипта тот же файл передаётся через `--llm_system_prompt_file`. Промпт применяется и к Yandex Responses, и к другим провайдерам через системное сообщение. Он управляет содержанием и формулировками ответа; тембр голоса Qwen3-TTS Base берёт из образца WAV. Для Yandex нужен `YANDEX_AISTUDIO_KEY` в `.env` или окружении.

Для проверки скорости без reasoning у Yandex добавьте к команде запуска `--llm-reasoning-effort none`. Без этого параметра используется поведение модели по умолчанию. В обычном запуске LiveTalking тот же параметр называется `--llm_reasoning_effort none`.

## Сервисы моделей

Для моделей нужны работающий CUDA GPU и отдельные окружения для vLLM и vLLM-Omni. Установите их по [инструкции Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR#deployment-with-vllm) и [инструкции vLLM-Omni](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/quickstart/). При первой загрузке модели скачивают веса. Если обе модели не помещаются на одной карте, используйте две карты или два компьютера и задайте сетевые адреса в параметрах LiveTalking.

В окружении vLLM запустите ASR:

```bash
vllm serve Qwen/Qwen3-ASR-0.6B --host 127.0.0.1 --port 8092
```

В окружении vLLM-Omni запустите TTS:

```bash
vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-Base \
  --omni --deploy-config vllm_omni/deploy/qwen3_tts.yaml \
  --trust-remote-code --enforce-eager --host 127.0.0.1 --port 8091
```

Проверьте оба сервера:

```bash
curl -f http://127.0.0.1:8092/v1/models
curl -f http://127.0.0.1:8091/v1/models
```

После запуска обоих серверов проверьте полный цикл синтеза и распознавания:

```bash
python scripts/check_qwen_voice.py \
  --ref-file /полный/путь/к/voice.wav \
  --ref-text 'Дословный текст записи голоса.'
```

Скрипт сохранит `qwen3-voice-check.wav` и напечатает исходную и распознанную фразы.

## LiveTalking

Подготовьте WAV-запись голоса и точную расшифровку записи. Затем в окружении LiveTalking из каталога репозитория:

```bash
python app.py \
  --ASR_BACKEND qwen3asr \
  --ASR_SERVER http://127.0.0.1:8092 \
  --ASR_MODEL Qwen/Qwen3-ASR-0.6B \
  --tts qwen3tts \
  --TTS_SERVER http://127.0.0.1:8091 \
  --REF_FILE /полный/путь/к/voice.wav \
  --REF_TEXT 'Дословный текст записи голоса.'
```

Настройте `YANDEX_AISTUDIO_KEY` для выбранного в `config.yaml` LLM либо выберите другой `--llm_provider`. Откройте страницу аватара и в панели распознавания подключитесь к автоматически указанному `/api/asr`. Нажмите «Начать», произнесите фразу и нажмите «Стоп». Страница сохраняет пробелы в русском тексте и передаёт результат аватару.

Qwen3-ASR возвращает одну итоговую расшифровку через `/v1/audio/transcriptions`; переключатель `online` на старой странице распознавания не включает потоковую выдачу. При ошибке модельного сервиса страница показывает сообщение, а не отправляет пустой запрос в LLM. Для прежнего SenseVoice можно выбрать `--ASR_BACKEND sensevoice` при установленном `funasr`.
