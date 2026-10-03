import time
import os
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from avatars.base_avatar import BaseAvatar
from utils.logger import logger

# Built-in LLM providers; Yandex uses Responses, the others use chat completions.
LLM_PROVIDERS = {
    "dashscope": {
        "api_key_env": "DASHSCOPE_API_KEY",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "default_model": "qwen-plus",
    },
    "orcarouter": {
        "api_key_env": "ORCAROUTER_API_KEY",
        "base_url": "https://api.orcarouter.ai/v1",
        "default_model": "orcarouter/auto",
    },
    "yandex": {
        "api_key_env": "YANDEX_AISTUDIO_KEY",
        "base_url": "https://ai.api.cloud.yandex.net/v1",
        "default_model": "gpt://b1gnot6t4gp0jj7a56du/deepseek-v4.1-flash/latest",
        "project": "b1gnot6t4gp0jj7a56du",
    },
}

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful assistant. Reply briefly and conversationally "
    "in the same language as the user's message."
)


def _llm_provider(opt) -> str:
    """Return the configured provider name, defaulting to dashscope."""
    return getattr(opt, 'llm_provider', 'dashscope') or 'dashscope'


def _llm_client(opt):
    """Create the OpenAI-compatible client for the configured provider."""
    from openai import OpenAI
    provider = _llm_provider(opt)
    cfg = LLM_PROVIDERS.get(provider, LLM_PROVIDERS['dashscope'])
    if provider == 'yandex':
        api_key = os.getenv(cfg['api_key_env'])
        if not api_key:
            raise ValueError(f"{cfg['api_key_env']} is not set")
        return OpenAI(
            api_key=api_key,
            base_url=cfg['base_url'],
            project=getattr(opt, 'llm_project', '') or cfg['project'],
            default_headers={'Authorization': f'Api-Key {api_key}'},
        )
    return OpenAI(
        api_key=os.getenv(cfg['api_key_env']),
        base_url=cfg['base_url'],
    )


def _llm_model(opt) -> str:
    """Resolve the model name, falling back to the provider default."""
    cfg = LLM_PROVIDERS.get(_llm_provider(opt), LLM_PROVIDERS['dashscope'])
    return getattr(opt, 'llm_model', '') or cfg['default_model']


def _yandex_text_chunks(events):
    """Yield text deltas and surface failed Responses stream events."""
    for event in events:
        if event.type == 'response.output_text.delta':
            yield event.delta
        elif event.type in ('error', 'response.failed', 'response.incomplete'):
            response = getattr(event, 'response', None)
            error = getattr(event, 'error', None) or getattr(response, 'error', None)
            incomplete = getattr(response, 'incomplete_details', None)
            reason = (getattr(event, 'message', None)
                      or getattr(error, 'message', None)
                      or getattr(incomplete, 'reason', None)
                      or event.type)
            raise RuntimeError(f'Yandex AI Studio stream failed: {reason}')


def llm_response(message,avatar_session:'BaseAvatar',datainfo:dict={}):
    try:
        generation = getattr(avatar_session, "talk_generation", 0)
        opt = avatar_session.opt
        start = time.perf_counter()
        client = _llm_client(opt)
        model = _llm_model(opt)
        end = time.perf_counter()
        logger.info(f"llm Time init: {end-start}s,{message}")
        instructions = getattr(opt, 'llm_system_prompt', '') or DEFAULT_SYSTEM_PROMPT
        if _llm_provider(opt) == 'yandex':
            request = dict(model=model, instructions=instructions, input=message,
                           temperature=0.3, max_output_tokens=1500, stream=True)
            reasoning_effort = getattr(opt, 'llm_reasoning_effort', '')
            if reasoning_effort:
                request['reasoning'] = {'effort': reasoning_effort}
            completion = client.responses.create(**request)
            text_chunks = _yandex_text_chunks(completion)
        else:
            completion = client.chat.completions.create(
                model=model,
                messages=[{'role': 'system', 'content': instructions},
                          {'role': 'user', 'content': message}],
                stream=True,
                stream_options={"include_usage": True},
            )
            text_chunks = (chunk.choices[0].delta.content if chunk.choices else None for chunk in completion)
        result=""
        first = True
        for msg in text_chunks:
            if getattr(avatar_session, "talk_generation", 0) != generation:
                return
            if not msg:
                continue
            if first:
                end = time.perf_counter()
                logger.info(f"llm Time to first chunk: {end-start}s")
                first = False
            lastpos=0
            for i, char in enumerate(msg):
                if char in ",.!;:，。！？：；" :
                    result = result+msg[lastpos:i+1]
                    lastpos = i+1
                    if len(result)>10:
                        logger.info(result)
                        if getattr(avatar_session, "talk_generation", 0) != generation:
                            return
                        avatar_session.put_msg_txt(result,datainfo)
                        result=""
            result = result+msg[lastpos:]
        end = time.perf_counter()
        logger.info(f"llm Time to last chunk: {end-start}s")
        if result:
            if getattr(avatar_session, "talk_generation", 0) != generation:
                return
            avatar_session.put_msg_txt(result,datainfo)

    except Exception as e:
        logger.exception('llm exceptiopn:')
        return
