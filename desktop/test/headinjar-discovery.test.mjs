import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverHeadinjar } from '../electron/headinjar-discovery.mjs';

test('default same-computer receiver appears even when Avahi is unavailable', async () => {
  const found = await discoverHeadinjar({
    browse: async () => { throw new Error('Avahi unavailable'); },
    fetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:19840/api/info');
      return { ok: true, json: async () => ({ name: 'headinjar', protocol: 1, auth: 'local', whip: '/whip', busy: false }) };
    },
  });
  assert.deepEqual(found, [{ name: 'Head in Jar · this computer', url: 'http://127.0.0.1:19840/whip', auth: 'local' }]);
});

test('unreachable LAN advertisement does not hide a working same-computer receiver', async () => {
  const found = await discoverHeadinjar({
    browse: async () => '=;eth0;IPv4;Offline;_headinjar._tcp;local;host.local;192.168.8.12;19840;"protocol=1" "auth=local" "whip=/whip" "address=192.168.8.12"',
    fetch: async url => url.startsWith('http://127.0.0.1:')
      ? { ok: true, json: async () => ({ name: 'headinjar', protocol: 1, auth: 'local', whip: '/whip', busy: false }) }
      : { ok: false },
  });
  assert.deepEqual(found, [{ name: 'Head in Jar · this computer', url: 'http://127.0.0.1:19840/whip', auth: 'local' }]);
});

test('discovery verifies LAN advertisements against the live receiver and ignores mismatches', async () => {
  const lines = [
    '=;eth0;IPv4;Head\\032in\\032Jar;_headinjar._tcp;local;host.local;192.168.8.12;19840;"protocol=1" "auth=local" "whip=/whip" "address=192.168.8.12"',
    '=;eth0;IPv4;Spoof;_headinjar._tcp;local;evil.local;192.168.8.13;19840;"protocol=1" "auth=local" "whip=/whip" "address=192.168.8.14"',
    '=;eth0;IPv4;Secure;_headinjar._tcp;local;secure.local;192.168.8.15;19840;"protocol=1" "auth=local" "whip=/whip" "scheme=https" "address=192.168.8.15"',
  ].join('\n');
  const calls = [];
  const results = await discoverHeadinjar({
    browse: async () => lines,
    fetch: async (url, options) => {
      calls.push([url, options]);
      if (url === 'http://127.0.0.1:19840/api/info') return { ok: false };
      return { ok: true, json: async () => ({ name: 'headinjar', protocol: 1, auth: 'local', whip: '/whip', busy: false }) };
    },
  });
  assert.deepEqual(results, [
    { name: 'Head in Jar', url: 'http://192.168.8.12:19840/whip', auth: 'local' },
    { name: 'Secure', url: 'https://192.168.8.15:19840/whip', auth: 'local' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'http://192.168.8.12:19840/api/info');
});


test('discovery accepts a bearer-protected receiver but never supplies its secret', async () => {
  const line = '=;eth0;IPv4;Protected;_headinjar._tcp;local;host.local;192.168.8.12;19840;"protocol=1" "auth=bearer" "whip=/whip" "address=192.168.8.12"';
  const found = await discoverHeadinjar({
    browse: async () => line,
    fetch: async url => url.startsWith('http://127.0.0.1:') ? { ok: false }
      : { ok: true, json: async () => ({ name: 'headinjar', protocol: 1, auth: 'bearer', whip: '/whip', busy: false }) },
  });
  assert.deepEqual(found, [{ name: 'Protected', url: 'http://192.168.8.12:19840/whip', auth: 'bearer' }]);
});

test('loopback fallback discovers a bearer-protected receiver', async () => {
  const found = await discoverHeadinjar({ browse: async () => '',
    fetch: async () => ({ ok: true, json: async () => ({ name: 'headinjar', protocol: 1, auth: 'bearer', whip: '/whip' }) }) });
  assert.deepEqual(found, [{ name: 'Head in Jar · this computer', url: 'http://127.0.0.1:19840/whip', auth: 'bearer' }]);
});


test('discovery rejects a receiver whose live auth differs from mDNS', async () => {
  const line = '=;eth0;IPv4;Mismatch;_headinjar._tcp;local;host.local;192.168.8.12;19840;"protocol=1" "auth=local" "whip=/whip" "address=192.168.8.12"';
  const found = await discoverHeadinjar({ browse: async () => line,
    fetch: async url => url.startsWith('http://127.0.0.1:') ? { ok: false }
      : { ok: true, json: async () => ({ name: 'headinjar', protocol: 1, auth: 'bearer', whip: '/whip' }) } });
  assert.deepEqual(found, []);
});
