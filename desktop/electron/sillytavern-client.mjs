import { STUDIO_CHARACTER_AVATAR, viktorPetrovichCard } from './sillytavern-card.mjs';
import { sillyTavernCharacter } from '../src/sillytavern-character.mjs';

const STUDIO_CHAT = /^studio_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function chatName(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Conversation ID must be a UUID');
  return `studio_${id}`;
}

async function* sseContent(response) {
  if (!response.ok) throw new Error(`SillyTavern generation failed: HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let pending = '';
  for await (const bytes of response.body) {
    pending = (pending + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
    let index;
    while ((index = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, index);
      pending = pending.slice(index + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        const payload = JSON.parse(data);
        if (payload.error) throw new Error(`SillyTavern generation failed: ${payload.error.message || payload.error}`);
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      }
    }
  }
  throw new Error('SillyTavern generation stream ended without [DONE]');
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
    async *generate(messages, { apiKey, folderId, model = 'qwen3.6-35b-a3b', signal } = {}) {
      if (!apiKey || !folderId || !/^[a-z0-9_-]+$/i.test(folderId)) throw new Error('Yandex AI Studio key and folder ID are required');
      const headers = `Authorization: ${JSON.stringify(`Api-Key ${apiKey}`)}\nOpenAI-Project: ${JSON.stringify(folderId)}`;
      const response = await post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'custom', custom_url: 'https://ai.api.cloud.yandex.net/v1',
        custom_include_headers: headers, custom_include_body: 'reasoning_effort: none', model: `gpt://${folderId}/${model}`,
        messages, stream: true, max_tokens: 650, temperature: 0.3,
      }, { signal });
      yield* sseContent(response);
    },
  };
}
