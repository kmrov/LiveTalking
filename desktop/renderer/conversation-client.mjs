export function createConversationClient({ fetch, baseUrl, getSessionId }) {
  async function command(endpoint, payload = {}) {
    const sessionid = getSessionId();
    if (!sessionid) throw new Error('An active WebRTC session is required');
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid: String(sessionid), ...payload }),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.msg || `LiveTalking request failed: ${response.status}`);
    return result.data;
  }
  return {
    async sendText(text, { type = 'chat', interrupt = true } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Введите сообщение');
      if (!['echo', 'chat'].includes(type)) throw new Error('Invalid conversation mode');
      return command('/human', { text: text.trim(), type, interrupt: Boolean(interrupt) });
    },
    interrupt: () => command('/interrupt_talk'),
    startRecording: () => command('/record', { type: 'start_record' }),
    stopRecording: () => command('/record', { type: 'end_record' }),
    speaking: () => command('/is_speaking'),
  };
}
