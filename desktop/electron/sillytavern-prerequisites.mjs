import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sillyTavernHealth } from './sillytavern-supervisor.mjs';

const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const defaults = {
  exists: existsSync,
  health: sillyTavernHealth,
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
  results.push(environment.YANDEX_AISTUDIO_KEY && environment.YANDEX_FOLDER_ID
    ? item('sillytavern-credentials', 'ready', 'Yandex key and folder are configured')
    : item('sillytavern-credentials', 'missing', 'Yandex key or folder ID is missing', 'Enter the key and folder ID in SillyTavern brain settings.'));
  return results;
}
