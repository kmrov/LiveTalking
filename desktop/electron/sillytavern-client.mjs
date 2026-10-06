import { STUDIO_CHARACTER_AVATAR, viktorPetrovichCard } from './sillytavern-card.mjs';
import { sillyTavernCharacter } from '../src/sillytavern-character.mjs';

const STUDIO_CHAT = /^studio_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function chatName(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Conversation ID must be a UUID');
  return `studio_${id}`;
}

async function* characterStream(response) {
  const decoder = new TextDecoder();
  let pending = '';
  let finished = false;
  for await (const bytes of response.body) {
    pending = (pending + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const event = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === 'error') throw new Error(`SillyTavern character chat failed: ${payload.error || 'unknown error'}`);
      if (event === 'delta' && typeof payload.text === 'string') yield payload.text;
      if (event === 'done') { finished = true; break; }
    }
    if (finished) break;
  }
  if (!finished) throw new Error('SillyTavern character stream ended before the chat was saved');
}

export function createSillyTavernClient({ baseUrl, fetch: request = globalThis.fetch }) {
  const root = baseUrl.replace(/\/$/, '');
  let cookie = '', csrf = '';

  async function refreshCsrf() {
    const response = await request(`${root}/csrf-token`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`SillyTavern CSRF token unavailable: HTTP ${response.status}`);
    csrf = (await response.json()).token;
    const setCookie = response.headers.getSetCookie?.() ?? [response.headers.get('Set-Cookie')].filter(Boolean);
    if (setCookie.length) cookie = setCookie.map(value => value.split(';', 1)[0]).join('; ');
    if (!csrf || !cookie) throw new Error('SillyTavern did not provide a CSRF session');
  }

  async function post(endpoint, body, { allow404 = false, signal } = {}) {
    if (!csrf) await refreshCsrf();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await request(`${root}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: cookie },
        body: JSON.stringify(body), signal,
      });
      if (response.status !== 403 || attempt) break;
      await refreshCsrf();
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`SillyTavern ${endpoint}: HTTP ${response.status}`);
    return response;
  }

  async function json(endpoint, body, options) { return (await post(endpoint, body, options))?.json(); }

  return {
    async version() {
      const response = await request(`${root}/version`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`SillyTavern unavailable: HTTP ${response.status}`);
      const data = await response.json();
      if (!data.pkgVersion) throw new Error('This server is not SillyTavern');
      return data;
    },
    async ensureCard() {
      const existing = await json('/api/characters/get', { avatar_url: STUDIO_CHARACTER_AVATAR }, { allow404: true });
      if (existing) return STUDIO_CHARACTER_AVATAR;
      const avatar = (await (await post('/api/characters/create', viktorPetrovichCard)).text()).trim();
      if (avatar !== STUDIO_CHARACTER_AVATAR) throw new Error(`Unexpected SillyTavern character name: ${avatar}`);
      return avatar;
    },
    async characters() {
      const items = await json('/api/characters/all', {});
      if (!Array.isArray(items)) throw new Error('SillyTavern did not return characters');
      return items.filter(item => typeof item?.name === 'string' && typeof item?.avatar === 'string')
        .map(item => ({ name: item.name, avatar: sillyTavernCharacter(item.avatar) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    },
    character: avatar => json('/api/characters/get', { avatar_url: sillyTavernCharacter(avatar) }),
    async conversations(avatar = STUDIO_CHARACTER_AVATAR) {
      const items = await json('/api/characters/chats', { avatar_url: sillyTavernCharacter(avatar), simple: false });
      if (!Array.isArray(items)) throw new Error('SillyTavern did not return conversations');
      return items.filter(item => STUDIO_CHAT.test(item.file_id)).map(item => ({
        id: STUDIO_CHAT.exec(item.file_id)[1], created_at: new Date(item.last_mes || Date.now()).toISOString(),
        updated_at: new Date(item.last_mes || Date.now()).toISOString(),
      }));
    },
    getChat: (avatar, id) => json('/api/chats/get', { avatar_url: sillyTavernCharacter(avatar), file_name: chatName(id) }),
    saveChat: (avatar, id, chat) => json('/api/chats/save', { avatar_url: sillyTavernCharacter(avatar), file_name: chatName(id), chat }),
    async *streamCharacterMessage(avatar, id, message, requestId) {
      const characterId = sillyTavernCharacter(avatar).slice(0, -4);
      const response = await post('/api/characters/chat', {
        character_id: characterId, chat_id: chatName(id), message, request_id: requestId, stream: true,
      });
      yield* characterStream(response);
    },
    async ensureCompletionSource({ apiKey, folderId, model = 'qwen3.6-35b-a3b', credentialMode = 'env' } = {}) {
      const payload = await json('/api/settings/get', {});
      const settings = typeof payload?.settings === 'string' ? JSON.parse(payload.settings) : payload?.settings;
      if (!settings || typeof settings !== 'object') throw new Error('SillyTavern settings are unavailable');
      const options = settings.oai_settings || {};
      const source = options.chat_completion_source;
      const selected = settings.main_api === 'openai' && (
        (source === 'custom' && options.custom_url && options.custom_model)
        || (source === 'openai' && options.openai_model)
        || (source === 'openrouter' && options.openrouter_model && options.openrouter_model !== 'OR_Website'));
      if (selected) {
        const environmentPlaceholder = '${ENV:SILLYTAVERN_CUSTOM_API_KEY}';
        if (source === 'custom' && credentialMode === 'env' && !apiKey
          && options.custom_include_headers?.includes(environmentPlaceholder)) {
          throw new Error('SillyTavern Custom source requires SILLYTAVERN_CUSTOM_API_KEY; set it or enter the Yandex key in Studio');
        }
        if (source === 'custom' && credentialMode === 'secret' && apiKey
          && options.custom_include_headers?.includes(environmentPlaceholder)) {
          await json('/api/secrets/write', { key: 'api_key_custom', value: apiKey, label: 'LiveTalking Studio' });
          settings.oai_settings.custom_include_headers = options.custom_include_headers.replaceAll(environmentPlaceholder, '${SECRET:CUSTOM}');
          await json('/api/settings/save', settings);
        }
        return { configured: true, bootstrapped: false };
      }
      if (settings.main_api === 'openai' && source) {
        if (!['custom', 'openai', 'openrouter'].includes(source)) {
          throw new Error(`Selected SillyTavern Chat Completion source "${source}" is not supported by the character chat API`);
        }
        throw new Error(`Selected SillyTavern Chat Completion source "${source}" has no usable model or URL`);
      }
      if (options.custom_url && options.custom_model) {
        throw new Error('SillyTavern has an existing Custom source; select Chat Completion there before starting Studio');
      }
      if (!apiKey || !folderId || !/^[a-z0-9_-]+$/i.test(folderId)) {
        throw new Error('Yandex key and folder ID are required for the first SillyTavern setup');
      }
      if (!['env', 'secret'].includes(credentialMode)) throw new Error('Unknown SillyTavern credential mode');
      if (credentialMode === 'secret') {
        await json('/api/secrets/write', { key: 'api_key_custom', value: apiKey, label: 'LiveTalking Studio' });
      }
      const placeholder = credentialMode === 'env' ? '${ENV:SILLYTAVERN_CUSTOM_API_KEY}' : '${SECRET:CUSTOM}';
      settings.main_api = 'openai';
      settings.oai_settings = {
        ...options,
        chat_completion_source: 'custom',
        custom_url: 'https://ai.api.cloud.yandex.net/v1',
        custom_model: `gpt://${folderId}/${model}`,
        custom_include_headers: `Authorization: ${JSON.stringify(`Api-Key ${placeholder}`)}\nOpenAI-Project: ${JSON.stringify(folderId)}`,
        custom_include_body: 'reasoning_effort: none',
        openai_max_context: 16384,
        openai_max_tokens: 650,
        temp_openai: 0.3,
      };
      await json('/api/settings/save', settings);
      return { configured: true, bootstrapped: true };
    },
    async completionSourceConfigured() {
      const payload = await json('/api/settings/get', {});
      const settings = typeof payload?.settings === 'string' ? JSON.parse(payload.settings) : payload?.settings;
      const options = settings?.oai_settings || {};
      return settings?.main_api === 'openai' && Boolean(
        (options.chat_completion_source === 'custom' && options.custom_url && options.custom_model)
        || (options.chat_completion_source === 'openai' && options.openai_model)
        || (options.chat_completion_source === 'openrouter' && options.openrouter_model && options.openrouter_model !== 'OR_Website'));
    },
  };
}
