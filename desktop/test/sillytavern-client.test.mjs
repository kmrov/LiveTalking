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

test('SillyTavern client uses standard chat routes', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, body: options.body && JSON.parse(options.body) });
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf-1' }), { headers: { 'Set-Cookie': 'session=abc' } });
    if (pathname === '/api/characters/chats') return Response.json([{ file_id: 'studio_11111111-1111-4111-8111-111111111111', last_mes: 12 }]);
    if (pathname === '/api/chats/get') return Response.json([{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }, { name: 'User', is_user: true, mes: 'Привет' }]);
    if (pathname === '/api/chats/save') return Response.json({ ok: true });
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  const chats = await client.conversations('Viktor_Petrovich_Studio.png');
  assert.equal(chats[0].id, '11111111-1111-4111-8111-111111111111');
  assert.equal((await client.getChat('Viktor_Petrovich_Studio.png', chats[0].id))[1].mes, 'Привет');
  await client.saveChat('Viktor_Petrovich_Studio.png', chats[0].id, [{ chat_metadata: {} }]);
});

test('SillyTavern client accepts character SSE without a Content-Type and with CRLF', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const request = async (url) => {
    if (url.endsWith('/csrf-token')) return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    return new Response('event: delta\r\ndata: {"text":"Привет"}\r\n\r\nevent: done\r\ndata: {"message":"Привет"}\r\n\r\n');
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  const chunks = [];
  for await (const chunk of client.streamCharacterMessage('Mira.png', '11111111-1111-4111-8111-111111111111', 'Hello', 'req-1')) chunks.push(chunk);
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

test('SillyTavern client streams a stored character turn with character and chat IDs', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  let requestBody;
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    if (pathname === '/api/characters/chat') {
      requestBody = JSON.parse(options.body);
      return new Response('event: delta\ndata: {"text":"Здрав"}\n\nevent: delta\ndata: {"text":"ствуй"}\n\nevent: done\ndata: {"chat_id":"studio_11111111-1111-4111-8111-111111111111","message":"Здравствуй"}\n\n');
    }
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  const chunks = [];
  for await (const chunk of client.streamCharacterMessage('Mira.png', '11111111-1111-4111-8111-111111111111', 'Привет', 'req-1')) chunks.push(chunk);
  assert.deepEqual(chunks, ['Здрав', 'ствуй']);
  assert.deepEqual(requestBody, { character_id: 'Mira', chat_id: 'studio_11111111-1111-4111-8111-111111111111', message: 'Привет', request_id: 'req-1', stream: true });
});

test('first setup stores a Custom source with an environment placeholder and preserves other settings', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    calls.push({ pathname, body: JSON.parse(options.body) });
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'koboldhorde', username: 'Keeper', oai_settings: {} }) });
    return Response.json({ result: 'ok' });
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  await client.ensureCompletionSource({ apiKey: 'secret', folderId: 'folder', model: 'model', credentialMode: 'env' });
  const saved = calls.find(call => call.pathname === '/api/settings/save').body;
  assert.equal(saved.username, 'Keeper');
  assert.equal(saved.main_api, 'openai');
  assert.equal(saved.oai_settings.custom_model, 'gpt://folder/model');
  assert.ok(saved.oai_settings.openai_max_context >= 8192, 'a full Studio character card must fit alongside the reply');
  assert.match(saved.oai_settings.custom_include_headers, /\$\{ENV:SILLYTAVERN_CUSTOM_API_KEY\}/);
  assert.doesNotMatch(JSON.stringify(saved), /secret/);
  assert.equal(calls.some(call => call.pathname === '/api/secrets/write'), false);
});

test('adopted SillyTavern stores the key in its secret store during first setup', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    calls.push({ pathname, body: JSON.parse(options.body) });
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'koboldhorde', oai_settings: {} }) });
    return Response.json({ result: 'ok' });
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  await client.ensureCompletionSource({ apiKey: 'secret', folderId: 'folder', model: 'model', credentialMode: 'secret' });
  assert.equal(calls.find(call => call.pathname === '/api/secrets/write').body.key, 'api_key_custom');
  assert.equal(calls.find(call => call.pathname === '/api/secrets/write').body.value, 'secret');
  const saved = calls.find(call => call.pathname === '/api/settings/save').body;
  assert.match(saved.oai_settings.custom_include_headers, /\$\{SECRET:CUSTOM\}/);
  assert.doesNotMatch(JSON.stringify(saved), /secret/);
});

test('an existing Chat Completion source is not replaced by Studio bootstrap', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    calls.push(pathname);
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'openai', oai_settings: {
      chat_completion_source: 'custom', custom_url: 'http://local/v1', custom_model: 'own-model',
    } }) });
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  await client.ensureCompletionSource({ credentialMode: 'env' });
  assert.deepEqual(calls, ['/api/settings/get']);
});

test('adopting a Studio-configured server moves only its environment credential to the secret store', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    calls.push({ pathname, body: JSON.parse(options.body) });
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'openai', oai_settings: {
      chat_completion_source: 'custom', custom_url: 'https://ai.api.cloud.yandex.net/v1', custom_model: 'my-model',
      custom_include_headers: 'Authorization: "Api-Key ${ENV:SILLYTAVERN_CUSTOM_API_KEY}"',
    } }) });
    return Response.json({ result: 'ok' });
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  await client.ensureCompletionSource({ apiKey: 'secret', credentialMode: 'secret' });
  assert.equal(calls.find(call => call.pathname === '/api/secrets/write').body.value, 'secret');
  const saved = calls.find(call => call.pathname === '/api/settings/save').body;
  assert.equal(saved.oai_settings.custom_model, 'my-model');
  assert.match(saved.oai_settings.custom_include_headers, /\$\{SECRET:CUSTOM\}/);
});

test('Studio does not replace an intentionally selected unsupported provider', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const calls = [];
  const request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    calls.push(pathname);
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'openai', oai_settings: {
      chat_completion_source: 'claude', claude_model: 'selected-model',
    } }) });
    throw new Error(`must not write ${pathname}`);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  await assert.rejects(client.ensureCompletionSource({ apiKey: 'secret', folderId: 'folder' }), /not supported/);
  assert.deepEqual(calls, ['/api/settings/get']);
});

test('a managed Custom source with an environment placeholder requires a key at startup', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const request = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'openai', oai_settings: {
      chat_completion_source: 'custom', custom_url: 'https://example.com/v1', custom_model: 'model',
      custom_include_headers: 'Authorization: "Api-Key \${ENV:SILLYTAVERN_CUSTOM_API_KEY}"',
    } }) });
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  await assert.rejects(client.ensureCompletionSource({ credentialMode: 'env' }), /SILLYTAVERN_CUSTOM_API_KEY/);
});

test('OpenRouter placeholder model is not treated as a configured source', async () => {
  const { createSillyTavernClient } = await import('../electron/sillytavern-client.mjs');
  const request = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'csrf' }), { headers: { 'Set-Cookie': 'session=abc' } });
    if (pathname === '/api/settings/get') return Response.json({ settings: JSON.stringify({ main_api: 'openai', oai_settings: {
      chat_completion_source: 'openrouter', openrouter_model: 'OR_Website',
    } }) });
    throw new Error(pathname);
  };
  const client = createSillyTavernClient({ baseUrl: 'http://127.0.0.1:8001', fetch: request });
  assert.equal(await client.completionSourceConfigured(), false);
  await assert.rejects(client.ensureCompletionSource({ apiKey: 'secret', folderId: 'folder' }), /no usable model/);
});
