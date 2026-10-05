import assert from 'node:assert/strict';
import test from 'node:test';

test('SillyTavern client sends CSRF cookie and creates the Viktor card once', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf-1' }), { headers: { 'Set-Cookie': 'session=abc; Path=/' } });
    assert.equal(options.headers['X-CSRF-Token'], 'csrf-1');
    assert.equal(options.headers.Cookie, 'session=abc');
    if (pathname === '/api/characters/get') return new Response('', { status: 404 });
    if (pathname === '/api/characters/create') return new Response('Viktor_Petrovich_Studio.png');
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  assert.equal(await client.ensureCard(), 'Viktor_Petrovich_Studio.png');
  const created = JSON.parse(calls.find(call => call.pathname === '/api/characters/create').options.body);
  assert.equal(created.ch_name, 'Виктор Петрович');
  assert.match(created.description, /тёплый, прямой собеседник/);
  assert.doesNotMatch(created.description, /save_memory/);
});

test('SillyTavern client uses standard chat routes and streams model chunks', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, body: options.body && JSON.parse(options.body) });
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf-1' }), { headers: { 'Set-Cookie': 'session=abc' } });
    if (pathname === '/api/characters/chats') return Response.json([{ file_id: 'studio_11111111-1111-4111-8111-111111111111', last_mes: 12 }]);
    if (pathname === '/api/chats/get') return Response.json([{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }, { name: 'User', is_user: true, mes: 'Привет' }]);
    if (pathname === '/api/chats/save') return Response.json({ ok: true });
    if (pathname === '/api/backends/chat-completions/generate') return new Response('data: {"choices":[{"delta":{"content":"Здравствуй"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  const chats = await client.conversations('Viktor_Petrovich_Studio.png');
  assert.equal(chats[0].id, '11111111-1111-4111-8111-111111111111');
  assert.equal((await client.getChat('Viktor_Petrovich_Studio.png', chats[0].id))[1].mes, 'Привет');
  await client.saveChat('Viktor_Petrovich_Studio.png', chats[0].id, [{ chat_metadata: {} }]);
  const chunks = [];
  for await (const chunk of client.generate([{ role: 'user', content: 'Привет' }], { apiKey: 'key', folderId: 'folder' })) chunks.push(chunk);
  assert.deepEqual(chunks, ['Здравствуй']);
  const generation = calls.find(call => call.pathname === '/api/backends/chat-completions/generate').body;
  assert.equal(generation.chat_completion_source, 'custom');
  assert.equal(generation.custom_include_body, 'reasoning_effort: none');
});

test('SillyTavern client accepts upstream SSE without a Content-Type and with CRLF', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const request = async (url) => {
    if (url.endsWith('/csrf-token')) return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    return new Response('data: {"choices":[{"delta":{"reasoning_content":"skip"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"Привет"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  const chunks = [];
  for await (const chunk of client.generate([{ role: 'user', content: 'Привет' }], { apiKey: 'key', folderId: 'folder' })) chunks.push(chunk);
  assert.deepEqual(chunks, ['Привет']);
});

test('SillyTavern client lists character names and avatar filenames', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const request = async url => new URL(url).pathname === '/csrf-token'
    ? new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } })
    : Response.json([{ name: 'Зоя', avatar: 'Зоя.png' }, { name: 'Виктор Петрович', avatar: 'Viktor_Petrovich_Studio.png' }]);
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  assert.deepEqual(await client.characters(), [
    { name: 'Виктор Петрович', avatar: 'Viktor_Petrovich_Studio.png' },
    { name: 'Зоя', avatar: 'Зоя.png' },
  ]);
});
