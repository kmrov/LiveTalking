import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

async function processInfo(pid) {
  try {
    const [value, owner] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), stat(`/proc/${pid}`)]);
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), startTime: fields[19], uid: owner.uid };
  } catch { return null; }
}

async function ownedGroup(record) {
  const leader = await processInfo(record.pid);
  if (leader && (leader.uid !== process.getuid() || leader.group !== record.pid
    || leader.session !== record.pid || leader.startTime !== record.startTime)) return false;
  if (leader?.state !== 'Z' && leader) return true;
  // vLLM's API leader can exit while its engine remains in the same session.
  let names;
  try { names = await readdir('/proc'); } catch { return false; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const member = await processInfo(Number(name));
    if (member?.state !== 'Z' && member?.uid === process.getuid() && member.group === record.pid
      && member.session === record.pid && BigInt(member.startTime) >= BigInt(record.startTime)) return true;
  }
  return false;
}

export async function listOwnedSpeechModels(directory) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (!['asr', 'tts'].includes(record.stage) || !Number.isSafeInteger(record.pid)
      || record.pid <= 1 || name !== `${record.pid}.json` || !/^\d+$/.test(record.startTime)) continue;
    if (await ownedGroup(record)) result.push(record);
    else await unlink(file).catch(() => {});
  }
  return result;
}

export async function stopOwnedSpeechModel(directory, stage) {
  if (!['asr', 'tts'].includes(stage)) throw new Error('Unknown speech service');
  const models = (await listOwnedSpeechModels(directory)).filter(model => model.stage === stage);
  for (const model of models) {
    if (!await ownedGroup(model)) continue;
    try { process.kill(-model.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && await ownedGroup(model)) await new Promise(resolve => setTimeout(resolve, 100));
    if (await ownedGroup(model)) {
      try { process.kill(-model.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const forcedDeadline = Date.now() + 2000;
      while (Date.now() < forcedDeadline && await ownedGroup(model)) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (await ownedGroup(model)) throw new Error(`Could not stop ${stage.toUpperCase()} model server`);
    await unlink(path.join(directory, `${model.pid}.json`)).catch(() => {});
  }
  return listOwnedSpeechModels(directory);
}
