import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function startFixtureServer() {
  const commands = [];
  const conversations = [], history = new Map(), streams = new Set();
  const control = { brainMode: 'direct', currentConversation: '', pendingTurn: null, failNextTurn: false,
    avatarModel:'wav2lip',avatarRoot:fileURLToPath(new URL('../..',import.meta.url)).replace(/\/$/,''), whip: null,
    delayOfferMs: 0, delayWhipMs: 0 };
  function send(event, fields = {}) {
    if (!control.pendingTurn) return;
    const turn = control.pendingTurn;
    if (event === 'delta') turn.text += fields.text;
    const body = JSON.stringify({ brain: 'persona', event, conversation_id: turn.conversation, request_id: turn.request, ...fields });
    for (const stream of streams) stream.write(`data: ${body}\n\n`);
  }
  function finishTurn() {
    if (!control.pendingTurn) return;
    const turn = control.pendingTurn;
    send('delta', { text: 'Это тестовый ответ.' });
    const text = 'Привет, сынок. Это тестовый ответ.';
    history.get(turn.conversation).push({ id: randomUUID(), role: 'assistant', text, request_id: turn.request });
    send('done', { text }); send('idle', { pending: 0 }); control.pendingTurn = null;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/sse?')) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(': connected\n\n');
      streams.add(response); response.once('close', () => streams.delete(response));
      if (control.pendingTurn) {
        const turn = control.pendingTurn;
        response.write(`data: ${JSON.stringify({ brain: 'persona', event: 'snapshot', conversation_id: turn.conversation, request_id: turn.request,
          status: turn.text ? 'delta' : 'queued', text: turn.text, user_text: turn.userText, pending: 1 })}\n\n`);
      }
      return;
    }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try { if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { response.writeHead(400); response.end('{}'); return; }
    if (request.method === 'POST') commands.push({ path: request.url, body });
    let result;
    if (request.url === '/api/desktop/health') result = { code: 0, msg: 'ok', data: { service: 'livetalking', api_version: 1,
      avatar:{model:control.avatarModel,root:control.avatarRoot},brain: { mode: control.brainMode, url: `http://127.0.0.1:${server.address().port}` } } };
    else if (request.url === '/api/v1/health') result = { status: 'ok' };
    else if (request.url === '/api/v1/capabilities') result = { service: 'persona', speech_stream: 1 };
    else if (request.url === '/api/v1/conversations' && request.method === 'POST') {
      result = { id: randomUUID(), created_at: new Date().toISOString() };
      conversations.unshift(result); history.set(result.id, []);
    }
    else if (request.url === '/api/v1/conversations') result = conversations;
    else if (/^\/api\/v1\/conversations\/[^/]+\/messages$/.test(request.url)) result = history.get(request.url.split('/')[4]) || [];
    else if (request.url === '/api/v1/memories') result = [{ text: 'Тестовая память' }];
    else if (request.url === '/api/v1/documents') result = { id: randomUUID(), title: body.title };
    else if (request.url === '/v1/models') result = { data: [{ id: 'Qwen/Qwen3-ASR-0.6B' }, { id: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base' }] };
    else if (request.url === '/api/whip/connect' && request.method === 'POST') {
      if (control.delayWhipMs) await new Promise(resolve => setTimeout(resolve, control.delayWhipMs));
      control.whip = { state: 'connected', url: body.url, sessionid: body.sessionid, lease: body.lease };
      control.currentConversation = body.persona_conversation_id || '';
      result = { code: 0, data: control.whip };
    }
    else if (request.url.startsWith('/api/whip/status?')) {
      const sessionid = new URL(request.url, 'http://localhost').searchParams.get('sessionid');
      result = { code: 0, data: control.whip?.sessionid === sessionid ? control.whip : { state: 'disconnected', url: '' } };
    }
    else if (request.url === '/api/whip/disconnect' && request.method === 'POST') {
      if (control.whip && (control.whip.sessionid !== body.sessionid || control.whip.lease !== body.lease)) {
        response.writeHead(409);
        result = { code: -1, msg: 'WHIP session lease changed' };
      } else {
        control.whip = null;
        result = { code: 0, data: { state: 'disconnected', url: '' } };
      }
    }
    else if (request.url === '/api/brain/session' && request.method === 'POST') {
      if (!history.has(body.conversation_id)) {
        response.writeHead(400); result = { code: -1, msg: 'conversation not found' };
      } else {
        control.currentConversation = body.conversation_id;
        result = { code: 0, data: { conversation_id: body.conversation_id, pending: 0 } };
      }
    }
    else if (request.url === '/offer') {
      if (control.delayOfferMs) await new Promise(resolve => setTimeout(resolve, control.delayOfferMs));
      control.currentConversation = body.persona_conversation_id || '';
      result = { type: 'answer', sdp: 'fixture-answer', sessionid: 'fixture-session' };
    }
    else if (request.url === '/human' && body.type === 'chat' && control.brainMode === 'persona') {
      const messages = history.get(control.currentConversation);
      if (!messages) { response.writeHead(400); response.end(JSON.stringify({code:-1,msg:'conversation not found'})); return; }
      if (!messages.some(item => item.role === 'user' && item.request_id === body.request_id)) messages.push({ id: randomUUID(), role: 'user', text: body.text, request_id: body.request_id });
      control.pendingTurn = { conversation: control.currentConversation, request: body.request_id, text: '', userText: body.text };
      result = { code: 0, data: { conversation_id: control.currentConversation, request_id: body.request_id } };
      setTimeout(() => {
        send('queued', { pending: 1 });
        if (control.failNextTurn) { control.failNextTurn = false; send('error', { message: 'Fixture generation failed' }); send('idle', { pending: 0 }); control.pendingTurn = null; }
        else send('delta', { text: 'Привет, сынок. ' });
      }, 30);
    }
    else if (request.url === '/is_speaking') result = { code: 0, data: false };
    else if (['/human', '/interrupt_talk', '/record'].includes(request.url)) result = { code: 0, msg: 'ok' };
    else { response.writeHead(404); result = { code: -1, msg: 'Not found' }; }
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, commands, control, finishTurn,
    close: () => { for (const stream of streams) stream.end(); return new Promise(resolve => server.close(resolve)); } };
}
