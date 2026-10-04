export function createProjectionClient({ fetch, send, baseUrl, onState = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let currentSessionId = null;
  let owned = false;
  let connecting = false;
  let generation = 0;

  async function request(path, options) {
    if (send) return send(path.split('/').at(-1), options?.body ? JSON.parse(options.body) : {});
    const response = await fetch(`${baseUrl}${path}`, options);
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.msg || `Projection request failed: ${response.status}`);
    return result.data;
  }

  function accept(data) {
    currentSessionId = data?.state === 'connected' && data.sessionid !== undefined ? String(data.sessionid) : null;
    if (data?.state === 'disconnected' || data?.state === 'failed') owned = false;
    onState(data?.state || 'disconnected');
    return data;
  }

  async function status() {
    const observedGeneration = generation;
    const data = await request('/api/whip/status');
    return observedGeneration === generation ? accept(data) : { state: 'disconnected', url: '' };
  }

  async function disconnect() {
    ++generation;
    currentSessionId = null;
    const wasOwned = owned || connecting;
    owned = false;
    connecting = false;
    onState('disconnected');
    if (wasOwned) await request('/api/whip/disconnect', { method: 'POST' });
  }

  async function connect({ url, token, avatarId = '', referenceWav = '', referenceText = '', conversationId = '' }) {
    if (owned || connecting) throw new Error('Projection is already connecting or connected');
    const attempt = ++generation;
    connecting = true;
    onState('connecting');
    try {
      const data = await request('/api/whip/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, token, avatar: avatarId, refaudio: referenceWav,
          reftext: referenceText, persona_conversation_id: conversationId }),
      });
      if (attempt !== generation) throw new Error('Projection connection cancelled');
      connecting = false;
      owned = true;
      accept(data);
      for (let tries = 0; !currentSessionId && tries < 60; tries++) {
        await pause(500);
        if (attempt !== generation) throw new Error('Projection connection cancelled');
        await status();
        if (!owned) throw new Error('Projection stream disconnected');
      }
      if (!currentSessionId) throw new Error('Projection connection timed out');
      return currentSessionId;
    } catch (error) {
      if (attempt === generation) await disconnect().catch(() => {});
      throw error;
    }
  }

  return { connect, disconnect, status, sessionId: () => currentSessionId };
}
