import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sillyTavernHealth } from './sillytavern-supervisor.mjs';
import { createSillyTavernClient } from './sillytavern-client.mjs';

const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const defaults = {
  exists: existsSync,
  health: sillyTavernHealth,
  async completion(url) {
    try { return await createSillyTavernClient({ baseUrl: url }).completionSourceConfigured(); }
    catch { return false; }
  },
  async node() {
    const result = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0 && Number(/^v(\d+)/.exec(result.stdout)?.[1]) >= 22;
  },
};

export async function inspectSillyTavernPrerequisites(profile, environment, probes = defaults) {
  if (profile.brain.mode !== 'sillytavern') return [];
  const results = [];
  const root = profile.brain.sillyTavernRoot;
  const running = await probes.health(profile.brain.sillyTavernUrl);
  const installed = probes.exists(path.join(root, 'server.js')) && probes.exists(path.join(root, 'node_modules'));
  results.push(running || installed
    ? item('sillytavern', 'ready', running ? `SillyTavern API: ${profile.brain.sillyTavernUrl}` : `SillyTavern found: ${root}`)
    : item('sillytavern', 'missing', `SillyTavern is not ready: ${root}`, `Select its checkout and run npm ci in ${root}.`));
  results.push(await probes.node()
    ? item('sillytavern-node', 'ready', 'Node.js 22 or newer is available')
    : item('sillytavern-node', 'missing', 'Node.js 22 or newer is unavailable', 'Install Node.js 22 or newer.'));
  const configured = running && await probes.completion?.(profile.brain.sillyTavernUrl);
  const credentials = (environment.YANDEX_AISTUDIO_KEY || environment.SILLYTAVERN_CUSTOM_API_KEY || process.env.SILLYTAVERN_CUSTOM_API_KEY)
    && environment.YANDEX_FOLDER_ID;
  results.push(configured || credentials || (installed && !running)
    ? item('sillytavern-credentials', 'ready', configured ? 'SillyTavern Chat Completion is configured'
      : credentials ? 'Yandex key and folder are ready for first setup'
        : 'SillyTavern Chat Completion will be checked after startup')
    : item('sillytavern-credentials', 'missing', 'First SillyTavern setup needs a Yandex key and folder ID', 'Enter them in Studio, or configure Chat Completion in SillyTavern.'));
  return results;
}
