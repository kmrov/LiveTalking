import { readFile, writeFile, mkdir, copyFile, realpath, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNMmXaCARtgwio6aCUAYr8B0jIwXssAAAAASUVORK5CYII=', 'base64');
export async function avatarFixtureOptions(root, userData) {
  const canonical = await realpath(root), base = await realpath(userData);
  if (!canonical.startsWith(base + path.sep)) throw new Error('Avatar fixture must be inside test userData.');
  const checkRoot = async value => { if (await realpath(value) !== canonical) throw new Error('Unexpected avatar fixture root.'); };
  const inspectCreation = async input => { await checkRoot(input.root); return [{ id: 'fixture-avatar', state: 'ready', detail: 'Avatar fixture ready', action: '' }]; };
  return {
    root: canonical, inspectCreation,
    inspectPreview: async input => { await checkRoot(input.root); return 'data:image/png;base64,' + png.toString('base64'); },
    spawn: (_python, args, options) => spawn(process.execPath, [fileURLToPath(import.meta.url), '--job', args.at(-1)], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }),
    moveDirectoryNoReplace: async (staged, final, context) => { await checkRoot(context.root); await rename(staged, final); },
  };
}

async function runWorker(requestFile) {
  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  const event = (state, stage, progress, extra = {}) => process.stdout.write('LT_AVATAR ' + JSON.stringify({ version: 1, jobId: request.jobId, state, stage, progress, message: '', ...extra }) + '\n');
  console.log(`fixture pid=${process.pid}`);
  await mkdir(path.join(request.jobDir, 'source'), { recursive: true });
  await copyFile(request.sourceFile, path.join(request.jobDir, 'source', 'input' + path.extname(request.sourceFile).toLowerCase()));
  event('running', 'generating', 25);
  let control;
  do {
    control = JSON.parse(await readFile(path.join(request.root, 'fixture-control.json'), 'utf8'));
    if (control.mode === 'delay') await new Promise(resolve => setTimeout(resolve, 50));
  } while (control.mode === 'delay');
  if (control.mode === 'fail') { event('failed', 'generating', 25, { message: 'Fixture generation failed' }); process.exitCode = 1; return; }
  const output = path.join(request.jobDir, 'output', request.avatarId);
  const directories = request.model === 'musetalk' ? ['full_imgs', 'mask'] : ['full_imgs', 'face_imgs'];
  for (const directory of directories) {
    await mkdir(path.join(output, directory), { recursive: true });
    await writeFile(path.join(output, directory, '00000000.png'), png);
  }
  for (const file of request.model === 'musetalk' ? ['coords.pkl', 'mask_coords.pkl', 'latents.pt'] : ['coords.pkl']) await writeFile(path.join(output, file), 'fixture');
  await writeFile(path.join(output, 'thumbnail.jpg'), png);
  event('prepared', 'validating', 95, { frameCount: 1 });
}
if (process.argv[2] === '--job') await runWorker(process.argv[3]);
