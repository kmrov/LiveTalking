// AVTR-1 receives the same 16 kHz PCM16 chunks as ASR. Keep at most two
// pending network batches so a slow avatar endpoint never stalls capture.
export function createListenAudioSender({ fetch, baseUrl, sessionId, batchSamples = 1600 }) {
  const address = new URL('/api/desktop/listen-audio', baseUrl);
  address.searchParams.set('sessionid', sessionId);
  const controller = new AbortController();
  const queue = [];
  let samples = [];
  let sending = false;
  let closed = false;

  async function pump() {
    if (sending || closed) return;
    sending = true;
    try {
      while (queue.length && !closed) {
        const body = queue.shift();
        try {
          const response = await fetch(address.href, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body, signal: controller.signal,
          });
          if (!response.ok && [403, 404, 409, 415].includes(response.status)) {
            close();
            break;
          }
        } catch {
          // Listening is best effort. The microphone and ASR stay active.
        }
      }
    } finally { sending = false; }
  }

  function enqueue(values) {
    const body = new ArrayBuffer(values.length * 2);
    const view = new DataView(body);
    values.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    if (queue.length === 2) queue.shift();
    queue.push(body);
    void pump();
  }

  function push(pcm) {
    if (closed || !pcm?.length) return;
    for (const sample of pcm) {
      samples.push(sample);
      if (samples.length === batchSamples) {
        enqueue(samples);
        samples = [];
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    samples = [];
    queue.length = 0;
    controller.abort();
  }

  return { push, close };
}
