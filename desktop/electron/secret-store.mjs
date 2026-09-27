import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const keyringBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

export function createFileSecretBackend(userDataPath) {
  const file = path.join(userDataPath, 'secrets.json');
  let records = {};
  try { records = JSON.parse(readFileSync(file, 'utf8')); } catch { /* No saved secrets yet. */ }
  function persist() {
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
    renameSync(temporary, file);
  }
  return {
    get: key => records[key],
    set(key, value) { records[key] = value; persist(); },
    delete(key) { delete records[key]; persist(); },
  };
}

export function createSecretStore({ safeStorage, backend }) {
  const memory = new Map();
  const keyring = Boolean(backend && safeStorage?.isEncryptionAvailable?.()
    && keyringBackends.has(safeStorage?.getSelectedStorageBackend?.()));
  function validateKey(key) {
    if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9:_-]{0,100}$/.test(key)) throw new Error('Invalid secret name');
  }
  return {
    persistent: keyring,
    set(key, value) {
      validateKey(key);
      if (typeof value !== 'string') throw new Error('Secret must be text');
      if (keyring) backend.set(key, safeStorage.encryptString(value).toString('base64'));
      else memory.set(key, value);
    },
    get(key) {
      validateKey(key);
      if (!keyring) return memory.get(key) ?? null;
      const encrypted = backend.get(key);
      return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : null;
    },
    delete(key) {
      validateKey(key);
      if (keyring) backend.delete(key);
      else memory.delete(key);
    },
  };
}
