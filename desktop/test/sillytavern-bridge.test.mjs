import assert from 'node:assert/strict';
import test from 'node:test';

const conversationId = '11111111-1111-4111-8111-111111111111';

function fakeSillyTavern() {
  const chats = new Map();
  let generations = 0;
  return {
    chats,
    get generations() { return generations; },
    async version() { return { pkgVersion: '1.19.0' }; },
    async ensureCard() { return 'Viktor_Petrovich_Studio.png'; },
    async character() { return { name: 'Виктор Петрович', data: { description: 'Говори тепло и кратко.' } }; },
    async conversations() { return [...chats.keys()].map(id => ({ id, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z' })); },
    async getChat(_avatar, id) { return structuredClone(chats.get(id) || []); },
    async saveChat(_avatar, id, chat) { chats.set(id, structuredClone(chat)); },
    async *generate(messages) {
      generations++;
      assert.equal(messages[0].content, 'Говори тепло и кратко.');
      assert.equal(messages.at(-1).content, 'Привет');
      yield 'Здравствуй';
      yield ', друг.';
    },
  };
}

test('SillyTavern bridge saves one chat turn and replays duplicate request without regeneration', async () => {
  const { createSillyTavernBridge } = await import('../electron/sillytavern-bridge.mjs');
  const client = fakeSillyTavern();
  const bridge = createSillyTavernBridge({ client, apiKey: 'secret', folderId: 'folder', randomUUID: () => conversationId });
  assert.equal((await bridge.createConversation()).id, conversationId);
  const first = [];
  for await (const item of bridge.events(conversationId, 'request-1', 'Привет')) first.push(item);
  assert.deepEqual(first.map(item => item.event), ['delta', 'delta', 'done']);
  assert.equal(first.at(-1).data.text, 'Здравствуй, друг.');
  const replay = [];
  for await (const item of bridge.events(conversationId, 'request-1', 'Привет')) replay.push(item);
  assert.equal(replay.at(-1).data.text, 'Здравствуй, друг.');
  assert.equal(client.generations, 1);
  assert.deepEqual((await bridge.history(conversationId)).map(item => item.role), ['user', 'assistant']);
  assert.equal(client.chats.get(conversationId).length, 3);
  await assert.rejects(async () => { for await (const _ of bridge.events(conversationId, 'request-1', 'Другое')) {} }, /different text/);
});

test('SillyTavern bridge keeps failed generation out of saved chat', async () => {
  const { createSillyTavernBridge } = await import('../electron/sillytavern-bridge.mjs');
  const client = fakeSillyTavern();
  client.generate = async function* () { yield 'Черновик'; throw new Error('upstream failed'); };
  const bridge = createSillyTavernBridge({ client, apiKey: 'secret', folderId: 'folder', randomUUID: () => conversationId });
  await bridge.createConversation();
  const items = [];
  for await (const item of bridge.events(conversationId, 'request-2', 'Привет')) items.push(item);
  assert.deepEqual(items.map(item => item.event), ['delta', 'error']);
  assert.equal((await bridge.history(conversationId)).length, 0);
});

test('SillyTavern bridge coalesces concurrent requests with the same ID', async () => {
  const { createSillyTavernBridge } = await import('../electron/sillytavern-bridge.mjs');
  const client = fakeSillyTavern();
  const bridge = createSillyTavernBridge({ client, apiKey: 'secret', folderId: 'folder', randomUUID: () => conversationId });
  await bridge.createConversation();
  const collect = async text => { const items = []; for await (const item of bridge.events(conversationId, 'request-3', text)) items.push(item); return items; };
  const [a, b] = await Promise.all([collect('Привет'), collect('Привет')]);
  assert.equal(a.at(-1).data.text, b.at(-1).data.text);
  assert.equal(client.generations, 1);
  assert.equal((await bridge.history(conversationId)).length, 2);
});

test('SillyTavern bridge switches characters and keeps chats and replies with their original card', async () => {
  const { createSillyTavernBridge } = await import('../electron/sillytavern-bridge.mjs');
  const secondId = '22222222-2222-4222-8222-222222222222';
  const saved = new Map();
  const cards = new Map([
    ['Viktor_Petrovich_Studio.png', { name: 'Виктор Петрович', data: { name: 'Виктор Петрович', description: 'Ты Виктор.' } }],
    ['Zoya.png', { name: 'Зоя', data: { name: 'Зоя', description: 'Ты Зоя.', first_mes: 'Привет от {{char}}.' } }],
  ]);
  const client = {
    async characters() { return [...cards].map(([avatar, card]) => ({ avatar, name: card.name })); },
    async character(avatar) { return cards.get(avatar); },
    async conversations(avatar) { return [...saved.keys()].filter(key => key.startsWith(`${avatar}:`)).map(key => ({ id: key.split(':')[1], updated_at: '2026-10-05T00:00:00Z' })); },
    async getChat(avatar, id) { return structuredClone(saved.get(`${avatar}:${id}`)); },
    async saveChat(avatar, id, chat) { saved.set(`${avatar}:${id}`, structuredClone(chat)); },
    async *generate(messages) { yield messages[0].content.includes('Ты Зоя.') ? 'Я Зоя.' : 'Я Виктор.'; },
  };
  const ids = [conversationId, secondId];
  const bridge = createSillyTavernBridge({ client, apiKey: 'key', folderId: 'folder', randomUUID: () => ids.shift() });
  await bridge.createConversation();
  assert.equal((await bridge.conversations()).length, 1);
  assert.deepEqual(await bridge.selectCharacter('Zoya.png'), { avatar: 'Zoya.png' });
  assert.deepEqual(await bridge.conversations(), []);
  assert.equal((await bridge.createConversation()).id, secondId);
  const items = [];
  for await (const item of bridge.events(secondId, 'request-zoya', 'Привет')) items.push(item);
  assert.equal(items.at(-1).data.text, 'Я Зоя.');
  assert.equal(saved.get(`Zoya.png:${secondId}`)[0].character_name, 'Зоя');
  assert.equal(saved.get(`Zoya.png:${secondId}`).at(-1).name, 'Зоя');
  assert.deepEqual((await bridge.history(secondId)).map(item => item.text), ['Привет', 'Я Зоя.']);
  assert.deepEqual(await bridge.selectCharacter('Viktor_Petrovich_Studio.png'), { avatar: 'Viktor_Petrovich_Studio.png' });
  assert.deepEqual((await bridge.conversations()).map(item => item.id), [conversationId]);
  assert.deepEqual((await bridge.history(secondId)).map(item => item.text), ['Привет', 'Я Зоя.']);
  await assert.rejects(bridge.selectCharacter('Missing.png'), /not found/);
});
