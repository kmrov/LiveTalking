import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { personaHealth } from './persona-supervisor.mjs';

const run = promisify(execFile);
const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const defaults = {
  exists: existsSync, health: personaHealth,
  async python(executable) {
    try {
      await run(executable, ['-c', 'import sys; assert sys.version_info[:2] == (3,13), "Need Python 3.13"; import fastapi, uvicorn, persona.main, psycopg, pgvector'], { timeout: 15000 });
      return { ok: true, detail: 'Python 3.13 and Persona dependencies are available' };
    } catch { return { ok: false, detail: 'Python 3.13 or Persona dependencies are unavailable' }; }
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

export async function inspectPersonaPrerequisites(profile, environment, probes = defaults) {
  if (profile.brain.mode !== 'persona') return [];
  const brain = profile.brain;
  if (await probes.health(brain.url)) return [item('persona', 'ready', `Persona with speech streaming is available: ${brain.url}`)];
  if (!brain.managed) return [item('persona', 'missing', `Persona is unavailable or needs an update: ${brain.url}`, 'Run an updated Persona API with /api/v1/capabilities and speech_stream=1.')];
  const results = [];
  results.push(probes.exists(path.join(brain.root, 'src/persona/main.py'))
    ? item('persona', 'ready', `Persona found: ${brain.root}`)
    : item('persona', 'missing', 'Persona folder not found', 'Select the folder containing src/persona/main.py.'));
  const python = await probes.python(brain.python);
  results.push(python.ok ? item('persona-python', 'ready', python.detail) : item('persona-python', 'missing', python.detail, 'Run uv sync in the Persona folder and select .venv/bin/python.'));
  results.push(environment.YANDEX_AISTUDIO_KEY && environment.YANDEX_FOLDER_ID
    ? item('persona-credentials', 'ready', 'Yandex key and folder are configured')
    : item('persona-credentials', 'missing', 'Yandex key or folder ID is missing', 'Enter the key and folder ID in Persona settings or its environment/.env.'));
  if (brain.databaseMode === 'compose') results.push(await probes.docker(brain.root, environment)
    ? item('persona-database', 'ready', 'Docker Compose and PostgreSQL service are available')
    : item('persona-database', 'missing', 'Docker Compose or PostgreSQL db is unavailable', 'Check Docker access and compose.yaml in the Persona folder, or choose an external database.'));
  else results.push(environment.PERSONA_DATABASE_URL
    ? item('persona-database', 'ready', 'External PostgreSQL is configured')
    : item('persona-database', 'missing', 'PostgreSQL URL is missing', 'Set PERSONA_DATABASE_URL in Persona .env or secure settings.'));
  return results;
}
