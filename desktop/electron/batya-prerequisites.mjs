import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { batyaHealth } from './batya-supervisor.mjs';

const run = promisify(execFile);
const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const defaults = {
  exists: existsSync, health: batyaHealth,
  async python(executable) {
    try {
      await run(executable, ['-c', 'import sys; assert sys.version_info[:2] == (3,13), "Need Python 3.13"; import fastapi, uvicorn, batya.main, psycopg, pgvector'], { timeout: 15000 });
      return { ok: true, detail: 'Python 3.13 and Batya dependencies are available' };
    } catch { return { ok: false, detail: 'Python 3.13 or Batya dependencies are unavailable' }; }
  },
  async docker(root, env) {
    try {
      const result = await run('docker', ['compose', 'config', '--services'], { cwd: root, env, timeout: 10000 });
      if (!result.stdout.split(/\s+/).includes('db')) return false;
      await run('docker', ['info', '--format', '{{.ServerVersion}}'], { env, timeout: 10000 });
      return true;
    } catch { return false; }
  },
};

export async function inspectBatyaPrerequisites(profile, environment, probes = defaults) {
  if (profile.brain.mode !== 'batya') return [];
  const brain = profile.brain;
  if (await probes.health(brain.url)) return [item('batya', 'ready', `Batya with speech streaming is available: ${brain.url}`)];
  if (!brain.managed) return [item('batya', 'missing', `Batya is unavailable or needs an update: ${brain.url}`, 'Run an updated Batya API with /api/v1/capabilities and speech_stream=1.')];
  const results = [];
  results.push(probes.exists(path.join(brain.root, 'src/batya/main.py'))
    ? item('batya', 'ready', `Batya found: ${brain.root}`)
    : item('batya', 'missing', 'Batya folder not found', 'Select the folder containing src/batya/main.py.'));
  const python = await probes.python(brain.python);
  results.push(python.ok ? item('batya-python', 'ready', python.detail) : item('batya-python', 'missing', python.detail, 'Run uv sync in the Batya folder and select .venv/bin/python.'));
  results.push(environment.YANDEX_AISTUDIO_KEY && environment.YANDEX_FOLDER_ID
    ? item('batya-credentials', 'ready', 'Yandex key and folder are configured')
    : item('batya-credentials', 'missing', 'Yandex key or folder ID is missing', 'Enter the key and folder ID in Batya settings or its environment/.env.'));
  if (brain.databaseMode === 'compose') results.push(await probes.docker(brain.root, environment)
    ? item('batya-database', 'ready', 'Docker Compose and PostgreSQL service are available')
    : item('batya-database', 'missing', 'Docker Compose or PostgreSQL db is unavailable', 'Check Docker access and compose.yaml in the Batya folder, or choose an external database.'));
  else results.push(environment.BATYA_DATABASE_URL
    ? item('batya-database', 'ready', 'External PostgreSQL is configured')
    : item('batya-database', 'missing', 'PostgreSQL URL is missing', 'Set BATYA_DATABASE_URL in Batya .env or secure settings.'));
  return results;
}
