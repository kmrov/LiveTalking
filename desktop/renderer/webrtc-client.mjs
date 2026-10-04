export function createWebRtcClient({ RTCPeerConnection, fetch, baseUrl, onState = () => {}, onTrack = () => {} }) {
  let connection = null;
  let currentSessionId = null;
  let generation = 0;

  function disconnect() {
    ++generation;
    currentSessionId = null;
    const previous = connection;
    connection = null;
    previous?.close();
    onState('disconnected');
  }

  async function waitForIce(peer) {
    if (peer.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('ICE gathering timed out')); }, 15000);
      function check() {
        if (peer.iceGatheringState === 'complete') {
          clearTimeout(timer);
          peer.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      }
      peer.addEventListener('icegatheringstatechange', check);
      check();
    });
  }

  async function connect({ avatarId, referenceWav = '', referenceText = '', conversationId = '' }) {
    if (connection) disconnect();
    const token = ++generation;
    const peer = new RTCPeerConnection({ sdpSemantics: 'unified-plan' });
    connection = peer;
    onState('connecting');
    peer.addEventListener('track', onTrack);
    peer.addEventListener('connectionstatechange', () => {
      if (token !== generation) return;
      if (peer.connectionState === 'connected') onState('connected');
      if (peer.connectionState === 'disconnected') onState('reconnecting');
      if (['failed', 'closed'].includes(peer.connectionState)) {
        ++generation;
        currentSessionId = null;
        connection = null;
        onState(peer.connectionState);
        if (peer.connectionState === 'failed') peer.close();
      }
    });
    try {
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      const response = await fetch(`${baseUrl}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: peer.localDescription.sdp, type: peer.localDescription.type,
          avatar: avatarId, refaudio: referenceWav, reftext: referenceText,
          ...(conversationId ? { persona_conversation_id: conversationId } : {}),
        }),
      });
      const answer = await response.json();
      if (!response.ok || answer.code !== undefined && answer.code !== 0) throw new Error(answer.msg || `WebRTC offer failed: ${response.status}`);
      if (!answer.sdp || !answer.type || answer.sessionid === undefined) throw new Error('Invalid WebRTC answer');
      await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
      if (token !== generation) throw new Error('WebRTC connection cancelled');
      currentSessionId = String(answer.sessionid);
      onState(peer.connectionState === 'connected' ? 'connected' : 'negotiating');
      return currentSessionId;
    } catch (error) {
      if (token === generation) {
        currentSessionId = null;
        connection = null;
        onState('failed');
      }
      peer.close();
      throw error;
    }
  }

  return { connect, disconnect, sessionId: () => currentSessionId, peer: () => connection };
}
