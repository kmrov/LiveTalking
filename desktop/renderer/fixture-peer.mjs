// Used only when the main process explicitly enables the smoke fixture.
export class FixturePeer {
  iceGatheringState = 'complete';
  connectionState = 'new';
  listeners = new Map();
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription() {
    this.connectionState = 'connected';
    this.listeners.get('connectionstatechange')?.();
  }
  close() { this.connectionState = 'closed'; this.listeners.get('connectionstatechange')?.(); }
}
