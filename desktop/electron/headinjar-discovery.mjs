import { execFile } from 'node:child_process';

function browseServices() {
  return new Promise((resolve, reject) => {
    execFile('avahi-browse', ['-rtpk', '_headinjar._tcp'], { timeout: 4000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Head in Jar discovery is unavailable: ${error.message}`));
      else resolve(stdout);
    });
  });
}

function privateIPv4(address) {
  const octets = address?.split('.').map(Number);
  return octets?.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && (octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
      || octets[0] === 192 && octets[1] === 168);
}

function decodeAvahi(value) {
  return value.replace(/\\([0-9]{3})/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseRecords(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const fields = line.split(';');
    if (fields.length < 10 || fields[0] !== '=' || fields[2] !== 'IPv4'
      || fields[4] !== '_headinjar._tcp' || !privateIPv4(fields[7])) return [];
    const port = Number(fields[8]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
    const properties = new Map([...fields.slice(9).join(';').matchAll(/"([^"\r\n]+)"/g)].map(match => {
      const separator = match[1].indexOf('=');
      return separator < 0 ? [match[1], ''] : [match[1].slice(0, separator), match[1].slice(separator + 1)];
    }));
    const scheme = properties.get('scheme') || 'http';
    if (!['http', 'https'].includes(scheme) || properties.get('protocol') !== '1' || !['local', 'bearer'].includes(properties.get('auth'))
      || properties.get('whip') !== '/whip' || properties.get('address') !== fields[7]) return [];
    return [{ name: decodeAvahi(fields[3]).slice(0, 80), address: fields[7], port, scheme, auth: properties.get('auth') }];
  });
}

export async function discoverHeadinjar({ browse = browseServices, fetch = globalThis.fetch } = {}) {
  let records = [];
  let browseError;
  try { records = parseRecords(await browse()); }
  catch (error) { browseError = error; }
  const local = { name: 'Head in Jar · this computer', address: '127.0.0.1', port: 19840, scheme: 'http' };
  async function verify(record) {
    const origin = `${record.scheme}://${record.address}:${record.port}`;
    try {
      const response = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) return null;
      const info = await response.json();
      if (info.name !== 'headinjar' || info.protocol !== 1 || !['local', 'bearer'].includes(info.auth) || (record.auth && info.auth !== record.auth) || info.whip !== '/whip') return null;
      return { name: record.name, url: `${origin}/whip`, auth: info.auth };
    } catch { return null; }
  }
  const verified = await Promise.all(records.slice(0, 30).map(verify));
  const found = [...new Map(verified.filter(Boolean).map(item => [item.url, item])).values()];
  if (!found.length) {
    const sameComputer = await verify(local);
    if (sameComputer) found.push(sameComputer);
  }
  if (!found.length && browseError) throw browseError;
  return found;
}
