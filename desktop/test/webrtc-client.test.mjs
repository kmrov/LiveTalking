import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcClient } from '../renderer/webrtc-client.mjs';

class FakePeer {
  constructor() { this.listeners = new Map(); this.transceivers = []; this.iceGatheringState = 'complete'; this.connectionState = 'new'; }
  addTransceiver(kind, options) { this.transceivers.push([kind, options.direction]); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'local-sdp' }); }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription(answer) { this.remoteDescription = answer; }
  fire(name, event) { this.listeners.get(name)?.(event); }
  close() { this.connectionState = 'closed'; this.fire('connectionstatechange'); }
}

test('WebRTC client sends avatar and voice parameters and retains returned session ID', async () => {
  let body;
  const client = createWebRtcClient({
    RTCPeerConnection: FakePeer,
    fetch: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ type: 'answer', sdp: 'remote-sdp', sessionid: 123 }) }; },
    baseUrl: 'http://127.0.0.1:8010', onState: () => {}, onTrack: () => {},
  });
  await client.connect({ avatarId: 'avatar_1', referenceWav: '/tmp/голос.wav', referenceText: 'Привет' });
  assert.equal(body.avatar, 'avatar_1');
  assert.equal(body.refaudio, '/tmp/голос.wav');
  assert.equal(body.reftext, 'Привет');
  assert.equal(client.sessionId(), '123');
  assert.deepEqual(client.peer().transceivers, [['video', 'recvonly'], ['audio', 'recvonly']]);
  assert.equal(client.peer().remoteDescription.sdp, 'remote-sdp');
});

test('WebRTC client delivers tracks and clears session on connection failure', async () => {
  const tracks = [];
  const states = [];
  const client = createWebRtcClient({ RTCPeerConnection: FakePeer, fetch: async () => ({ ok: true, json: async () => ({ type: 'answer', sdp: 'remote', sessionid: 'abc' }) }), baseUrl: 'http://127.0.0.1:8010', onState: state => states.push(state), onTrack: event => tracks.push(event) });
  await client.connect({ avatarId: 'avatar_1' });
  client.peer().fire('track', { track: { kind: 'video' }, streams: ['stream'] });
  assert.equal(tracks.length, 1);
  client.peer().connectionState = 'failed';
  client.peer().fire('connectionstatechange');
  assert.equal(client.sessionId(), null);
  assert.equal(states.at(-1), 'failed');
});

test('WebRTC client disconnects and rejects a failed offer', async () => {
  const client = createWebRtcClient({ RTCPeerConnection: FakePeer, fetch: async () => ({ ok: true, json: async () => ({ type: 'answer', sdp: 'remote', sessionid: 'abc' }) }), baseUrl: 'http://127.0.0.1:8010', onState: () => {}, onTrack: () => {} });
  await client.connect({ avatarId: 'avatar_1' });
  const peer = client.peer();
  client.disconnect();
  assert.equal(peer.connectionState, 'closed');
  assert.equal(client.sessionId(), null);
  const bad = createWebRtcClient({ RTCPeerConnection: FakePeer, fetch: async () => ({ ok: false, status: 500, json: async () => ({ msg: 'failed' }) }), baseUrl: 'http://127.0.0.1:8010', onState: () => {}, onTrack: () => {} });
  await assert.rejects(bad.connect({ avatarId: 'avatar_1' }), /failed/);
  assert.equal(bad.sessionId(), null);
});
