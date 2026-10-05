import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { STUDIO_CHARACTER_AVATAR } from './sillytavern-card.mjs';
import { sillyTavernCharacter } from '../src/sillytavern-character.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const now = () => new Date().toISOString();

function identifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Conversation ID must be a UUID');
  return value;
}

function acceptedMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error('Message must contain 1–20000 characters');
  return value.trim();
}

function acceptedRequest(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('request_id must contain 1–200 characters');
  return value;
}

function chatMessages(chat) {
  if (!Array.isArray(chat)) throw new Error('Invalid SillyTavern chat');
  return chat.filter(item => typeof item?.mes === 'string' && !item.is_system);
}

function prompt(card, chat, text) {
  const data = card.data || card;
  const name = data.name || card.name || 'Character';
  const expand = value => String(value).replace(/{{char}}/gi, name).replace(/{{user}}/gi, 'User');
  const system = [data.system_prompt, data.description, data.personality, data.scenario,
    data.mes_example && `Example dialogue:\n${data.mes_example}`].filter(Boolean).map(expand).join('\n\n') || `You are ${name}.`;
  return [
    { role: 'system', content: system },
    ...(chatMessages(chat).length || !data.first_mes ? [] : [{ role: 'assistant', content: expand(data.first_mes) }]),
    ...chatMessages(chat).slice(-12).map(item => ({ role: item.is_user ? 'user' : 'assistant', content: item.mes })),
    ...(data.post_history_instructions ? [{ role: 'system', content: expand(data.post_history_instructions) }] : []),
    { role: 'user', content: text },
  ];
}

function entry(text, requestId, isUser, characterName) {
  return { name: isUser ? 'User' : characterName, is_user: isUser, is_system: false,
    send_date: now(), mes: text, extra: { studio_request_id: requestId } };
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error('Request body is too large');
  }
  return JSON.parse(body || '{}');
}

function sendJson(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createSillyTavernBridge({ client, apiKey, folderId, model = 'qwen3.6-35b-a3b', randomUUID = nodeRandomUUID,
  avatar = STUDIO_CHARACTER_AVATAR, stUrl = 'http://127.0.0.1:8001' } = {}) {
  let selectedAvatar = sillyTavernCharacter(avatar);
  const conversationOwners = new Map();
  const jobs = new Map();
  const initializingJobs = new Map();
  const tails = new Map();

  async function characters() { return client.characters(); }

  async function selectCharacter(avatar) {
    const target = sillyTavernCharacter(avatar);
    const available = await characters();
    if (!available.some(item => item.avatar === target)) throw new Error('SillyTavern character not found');
    selectedAvatar = target;
    return { avatar: selectedAvatar };
  }

  async function conversations(avatar = selectedAvatar) {
    const items = await client.conversations(avatar);
    for (const item of items) conversationOwners.set(item.id, avatar);
    return items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async function createConversation() {
    const avatar = selectedAvatar;
    const id = identifier(randomUUID());
    const card = await client.character(avatar);
    const name = card.data?.name || card.name || 'Character';
    await client.saveChat(avatar, id, [{ chat_metadata: { livetalking_studio: true }, user_name: 'User', character_name: name }]);
    conversationOwners.set(id, avatar);
    return { id, created_at: now() };
  }

  async function getExistingChat(id) {
    identifier(id);
    const avatar = conversationOwners.get(id) || selectedAvatar;
    if (!(await conversations(avatar)).some(item => item.id === id)) throw new Error('Conversation not found');
    return { avatar, chat: await client.getChat(avatar, id) };
  }

  async function history(id) {
    const messages = chatMessages((await getExistingChat(id)).chat);
    return messages.map((item, index) => ({ role: item.is_user ? 'user' : 'assistant', text: item.mes,
      request_id: item.extra?.studio_request_id || `sillytavern-${index}`, created_at: item.send_date || now() }));
  }

  function push(job, event, data) {
    job.items.push({ event, data });
    for (const wake of job.waiters) wake();
    job.waiters.clear();
  }

  async function prepareJob(id, requestId, text) {
    const key = `${id}:${requestId}`;
    const cached = jobs.get(key);
    if (cached) {
      if (cached.text !== text) throw new Error('request_id already used with different text');
      return cached;
    }
    const { avatar, chat } = await getExistingChat(id);
    const previous = chatMessages(chat).find(item => item.extra?.studio_request_id === requestId);
    if (previous) {
      if (previous.mes !== text) throw new Error('request_id already used with different text');
      const answer = chatMessages(chat).find(item => !item.is_user && item.extra?.studio_request_id === requestId);
      if (answer) return { text, items: [{ event: 'delta', data: { text: answer.mes } },
        { event: 'done', data: { conversation_id: id, request_id: requestId, text: answer.mes, status: 'completed' } }],
      finished: true, waiters: new Set() };
    }
    const job = { text, avatar, items: [], finished: false, waiters: new Set() };
    jobs.set(key, job);
    const previousTail = tails.get(id);
    const run = (async () => {
      if (previousTail) await previousTail;
      try {
        const current = (await getExistingChat(id)).chat;
        const card = await client.character(avatar);
        const characterName = card.data?.name || card.name || 'Character';
        let answer = '';
        for await (const delta of client.generate(prompt(card, current, text), { apiKey, folderId, model })) {
          answer += delta;
          push(job, 'delta', { text: delta });
        }
        if (!answer.trim()) throw new Error('SillyTavern returned an empty answer');
        const latest = (await getExistingChat(id)).chat;
        await client.saveChat(avatar, id, [...latest, entry(text, requestId, true, characterName), entry(answer, requestId, false, characterName)]);
        push(job, 'done', { conversation_id: id, request_id: requestId, text: answer, status: 'completed' });
      } catch {
        jobs.delete(key);
        push(job, 'error', { code: 'generation_failed' });
      } finally {
        job.finished = true;
        for (const wake of job.waiters) wake();
        job.waiters.clear();
      }
    })();
    tails.set(id, run);
    run.finally(() => { if (tails.get(id) === run) tails.delete(id); });
    if (jobs.size > 256) {
      for (const [old, record] of jobs) { if (record.finished) { jobs.delete(old); break; } }
    }
    return job;
  }

  async function getJob(id, requestId, text) {
    const key = `${id}:${requestId}`;
    if (initializingJobs.has(key)) {
      const job = await initializingJobs.get(key);
      if (job.text !== text) throw new Error('request_id already used with different text');
      return job;
    }
    const pending = prepareJob(id, requestId, text);
    initializingJobs.set(key, pending);
    try { return await pending; }
    finally { if (initializingJobs.get(key) === pending) initializingJobs.delete(key); }
  }

  async function* events(id, requestId, rawText) {
    const text = acceptedMessage(rawText);
    acceptedRequest(requestId);
    const job = await getJob(identifier(id), requestId, text);
    let index = 0;
    while (true) {
      while (index < job.items.length) yield job.items[index++];
      if (job.finished) return;
      await new Promise(resolve => job.waiters.add(resolve));
    }
  }

  async function handler(request, response) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    try {
      if (request.method === 'GET' && path === '/api/v1/health') {
        await client.version(); await client.character(selectedAvatar);
        return sendJson(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && path === '/api/v1/capabilities') return sendJson(response, 200, { service: 'sillytavern', api_version: 1, speech_stream: 1, sillytavern_url: stUrl, character: selectedAvatar });
      if (request.method === 'GET' && path === '/api/v1/characters') return sendJson(response, 200, await characters());
      if (request.method === 'GET' && path === '/api/v1/character') return sendJson(response, 200, { avatar: selectedAvatar });
      if (request.method === 'POST' && path === '/api/v1/character') return sendJson(response, 200, await selectCharacter((await readBody(request)).avatar));
      if (request.method === 'GET' && path === '/api/v1/conversations') return sendJson(response, 200, await conversations());
      if (request.method === 'POST' && path === '/api/v1/conversations') return sendJson(response, 201, await createConversation());
      if (request.method === 'GET' && path === '/api/v1/memories') return sendJson(response, 200, []);
      const match = /^\/api\/v1\/conversations\/([^/]+)\/messages$/.exec(path);
      if (match && request.method === 'GET') return sendJson(response, 200, await history(match[1]));
      if (match && request.method === 'POST') {
        const body = await readBody(request);
        if (body.stream) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
          for await (const item of events(match[1], body.request_id, body.text)) response.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
          return response.end();
        }
        let result;
        for await (const item of events(match[1], body.request_id, body.text)) {
          if (item.event === 'error') throw new Error(item.data.code);
          if (item.event === 'done') result = item.data;
        }
        return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { detail: 'Not found' });
    } catch (error) {
      if (response.headersSent) {
        response.write(`event: error\ndata: ${JSON.stringify({ code: 'generation_failed' })}\n\n`);
        return response.end();
      }
      return sendJson(response, /not found/i.test(error.message) ? 404 : 400, { detail: error.message });
    }
  }

  const server = createServer((request, response) => { void handler(request, response); });
  return { characters, selectCharacter, conversations, createConversation, history, events, handler, server };
}
