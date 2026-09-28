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
      return { ok: true, detail: 'Python 3.13 и зависимости Бати доступны' };
    } catch { return { ok: false, detail: 'Python 3.13 или зависимости Бати недоступны' }; }
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
  if (await probes.health(brain.url)) return [item('batya', 'ready', `Батя с голосовым стримом доступен: ${brain.url}`)];
  if (!brain.managed) return [item('batya', 'missing', `Батя недоступен или требует обновления: ${brain.url}`, 'Запустите обновлённый API Бати с /api/v1/capabilities и speech_stream=1.')];
  const results = [];
  results.push(probes.exists(path.join(brain.root, 'src/batya/main.py'))
    ? item('batya', 'ready', `Батя найден: ${brain.root}`)
    : item('batya', 'missing', 'Каталог Бати не найден', 'Выберите каталог с src/batya/main.py.'));
  const python = await probes.python(brain.python);
  results.push(python.ok ? item('batya-python', 'ready', python.detail) : item('batya-python', 'missing', python.detail, 'В каталоге Бати выполните uv sync и укажите .venv/bin/python.'));
  results.push(environment.YANDEX_AISTUDIO_KEY && environment.YANDEX_FOLDER_ID
    ? item('batya-credentials', 'ready', 'Ключ и проект Yandex настроены')
    : item('batya-credentials', 'missing', 'Не заданы ключ Yandex или ID проекта', 'Заполните ключ и ID проекта в настройках Бати либо в его окружении/.env.'));
  if (brain.databaseMode === 'compose') results.push(await probes.docker(brain.root, environment)
    ? item('batya-database', 'ready', 'Docker Compose и сервис PostgreSQL доступны')
    : item('batya-database', 'missing', 'Docker Compose или PostgreSQL db недоступны', 'Проверьте доступ к Docker и compose.yaml в каталоге Бати; либо выберите внешнюю базу.'));
  else results.push(environment.BATYA_DATABASE_URL
    ? item('batya-database', 'ready', 'Внешняя PostgreSQL настроена')
    : item('batya-database', 'missing', 'Не указан адрес PostgreSQL', 'Задайте BATYA_DATABASE_URL в .env Бати или защищённых настройках.'));
  return results;
}
