export function createConversationClient({ fetch, baseUrl, getSessionId }) {
  async function command(endpoint, payload = {}, retry = false) {
    const sessionid = getSessionId();
    if (!sessionid) throw new Error('An active WebRTC session is required');
    const options = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid: String(sessionid), ...payload }),
      signal: AbortSignal.timeout(15000),
    };
    let response;
    try { response = await fetch(`${baseUrl}${endpoint}`, options); }
    catch (error) {
      if (!retry) throw error;
      response = await fetch(`${baseUrl}${endpoint}`, { ...options, signal: AbortSignal.timeout(15000) });
    }
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.msg || `LiveTalking request failed: ${response.status}`);
    return result.data;
  }
  return {
    async sendText(text, { type = 'chat', interrupt = true, requestId = '' } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Введите сообщение');
      if (!['echo', 'chat'].includes(type)) throw new Error('Invalid conversation mode');
      const request_id = type === 'chat' ? requestId || globalThis.crypto.randomUUID() : '';
      return command('/human', { text: text.trim(), type, interrupt: Boolean(interrupt), ...(request_id ? { request_id } : {}) }, type === 'chat');
    },
    interrupt: () => command('/interrupt_talk'),
    startRecording: () => command('/record', { type: 'start_record' }),
    stopRecording: () => command('/record', { type: 'end_record' }),
    speaking: () => command('/is_speaking'),
  };
}
