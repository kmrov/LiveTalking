import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normalizeProfile } from '../src/profile.mjs';

export function createProfileStore(userDataPath) {
  const file = path.join(userDataPath, 'profiles.json');
  let recovery = null;
  let data = { schemaVersion: 1, profiles: [], lastSuccessfulId: null };
  try {
    const loaded = JSON.parse(readFileSync(file, 'utf8'));
    if (loaded.schemaVersion !== 1 || !Array.isArray(loaded.profiles)) throw new Error('invalid profile schema');
    data = {
      schemaVersion: 1,
      profiles: loaded.profiles.map(normalizeProfile),
      lastSuccessfulId: loaded.lastSuccessfulId ?? null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const quarantine = path.join(userDataPath, `profiles.corrupt-${Date.now()}.json`);
      try { renameSync(file, quarantine); } catch { /* Keep the original if quarantine fails. */ }
      recovery = `Profile file was invalid; a backup was saved as ${path.basename(quarantine)}.`;
    }
  }

  function persist() {
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
  }

  return {
    list: () => structuredClone(data.profiles),
    get: id => structuredClone(data.profiles.find(profile => profile.id === id) ?? null),
    save(input) {
      const profile = normalizeProfile(input);
      const index = data.profiles.findIndex(current => current.id === profile.id);
      if (index < 0) data.profiles.push(profile);
      else data.profiles[index] = profile;
      persist();
      return structuredClone(profile);
    },
    remove(id) {
      data.profiles = data.profiles.filter(profile => profile.id !== id);
      if (data.lastSuccessfulId === id) data.lastSuccessfulId = null;
      persist();
    },
    lastSuccessfulId: () => data.lastSuccessfulId,
    setLastSuccessfulId(id) {
      if (id !== null && !data.profiles.some(profile => profile.id === id)) throw new Error('Unknown profile');
      data.lastSuccessfulId = id;
      persist();
    },
    recoveryError: () => recovery,
  };
}
