const uuid = id => {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('Conversation ID must be a UUID');
  return id;
};

export function createBatyaApi({ baseUrl, fetch: request = globalThis.fetch }) {
  async function call(endpoint, body) {
    const response = await request(baseUrl.replace(/\/$/, '') + '/api/v1' + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Батя: ${payload.detail?.code || payload.detail || `HTTP ${response.status}`}`);
    return payload;
  }
  return {
    conversations: () => call('/conversations'),
    createConversation: () => call('/conversations', {}),
    history: id => call(`/conversations/${uuid(id)}/messages`),
    memories: () => call('/memories'),
    document(input) {
      const body = {};
      for (const [key, limit] of [['title', 500], ['source', 1000], ['content', 1_000_000]]) {
        if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > limit) throw new Error(`Invalid document ${key}`);
        body[key] = input[key].trim();
      }
      return call('/documents', body);
    },
  };
}
