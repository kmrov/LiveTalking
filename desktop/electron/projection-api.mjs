import { randomUUID } from 'node:crypto';
import { discoverHeadinjar } from './headinjar-discovery.mjs';

const disconnected = { state: 'disconnected', url: '' };

export function createProjectionApi({ fetch = globalThis.fetch, getProfile, getServiceState, makeId = randomUUID, discover = discoverHeadinjar }) {
  let owner = null;
  let releasePending = null;
  let discoveredUrls = new Map();

  async function call(port, action, input = {}, sessionid = '') {
    const url = new URL(`http://127.0.0.1:${port}/api/whip/${action}`);
    if (action === 'status') url.searchParams.set('sessionid', sessionid);
    const response = await fetch(url.toString(), {
      method: action === 'status' ? 'GET' : 'POST',
      ...(action !== 'status' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(action === 'status' ? 10000 : 180000),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.msg || `WHIP ${action} failed: ${response.status}`);
    return result.data;
  }

  async function release() {
    if (releasePending) return releasePending;
    const current = owner;
    if (!current) return disconnected;
    owner = null;
    releasePending = (async () => {
      await current.connectPending?.catch(() => {});
      return call(current.port, 'disconnect', { sessionid: current.sessionid, lease: current.lease });
    })();
    try { return await releasePending; }
    finally { releasePending = null; }
  }

  async function request(profileId, action, input = {}) {
    if (!['connect', 'status', 'disconnect', 'discover'].includes(action)) throw new Error('Invalid action');
    if (action === 'discover') {
      const found = await discover();
      discoveredUrls = new Map(found.filter(item => ['local', 'bearer'].includes(item.auth)).map(item => [item.url, { auth: item.auth, expires: Date.now() + 30000 }]));
      return found;
    }
    const state = getServiceState();
    const profile = getProfile(profileId);
    if (!profile || state.profileId !== profileId || (action !== 'disconnect' && state.phase !== 'ready')) throw new Error('Projection requires the active profile');
    const port = profile.liveTalking.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LiveTalking port');
    if (action === 'disconnect') return release();
    if (action === 'status') {
      if (!owner || owner.profileId !== profileId) return disconnected;
      const current = owner;
      const result = await call(current.port, 'status', {}, current.sessionid);
      if (owner !== current || result.sessionid !== current.sessionid || result.lease !== current.lease) {
        if (owner === current) owner = null;
        return disconnected;
      }
      return result;
    }
    if (owner || releasePending) throw new Error('Projection is already connecting, connected, or disconnecting');
    let destination;
    try { destination = new URL(input.url); } catch { throw new Error('Enter the local Head in Jar WHIP URL'); }
    const oldLoopback = destination.hostname === '127.0.0.1' && destination.port === '19840';
    const discovered = discoveredUrls.get(destination.toString());
    const currentDiscovery = discovered?.expires > Date.now() ? discovered : null;
    if (currentDiscovery?.auth === 'bearer' && (typeof input.token !== 'string' || !input.token.trim())) {
      throw new Error('This Head in Jar requires a Bearer token');
    }
    const discoveredAllowed = currentDiscovery?.auth === 'bearer' || (currentDiscovery?.auth === 'local' && !input.token);
    if (!['http:', 'https:'].includes(destination.protocol) || (!oldLoopback && !discoveredAllowed)
        || destination.pathname !== '/whip' || destination.username || destination.password
        || destination.search || destination.hash) {
      throw new Error('Enter the local Head in Jar WHIP URL');
    }
    const current = { profileId, port, sessionid: makeId(), lease: makeId() };
    owner = current;
    try {
      current.connectPending = call(port, 'connect', { ...input, sessionid: current.sessionid, lease: current.lease });
      const result = await current.connectPending;
      if (owner !== current) throw new Error('Projection connection cancelled');
      if (result.sessionid !== current.sessionid || result.lease !== current.lease) {
        owner = null;
        throw new Error('Projection session ownership changed');
      }
      return result;
    } catch (error) {
      if (owner === current) await release().catch(() => {});
      throw error;
    }
  }

  return { request, release };
}
