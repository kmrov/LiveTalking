import { createServer } from 'node:http';

export async function startFixtureServer() {
  const commands = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try { if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { response.writeHead(400); response.end('{}'); return; }
    if (request.method === 'POST') commands.push({ path: request.url, body });
    let result;
    if (request.url === '/api/desktop/health') result = { code: 0, msg: 'ok', data: { service: 'livetalking', api_version: 1 } };
    else if (request.url === '/offer') result = { type: 'answer', sdp: 'fixture-answer', sessionid: 'fixture-session' };
    else if (request.url === '/is_speaking') result = { code: 0, data: false };
    else if (['/human', '/interrupt_talk', '/record'].includes(request.url)) result = { code: 0, msg: 'ok' };
    else { response.writeHead(404); result = { code: -1, msg: 'Not found' }; }
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, commands, close: () => new Promise(resolve => server.close(resolve)) };
}
