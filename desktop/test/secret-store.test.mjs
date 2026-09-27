import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecretStore } from '../electron/secret-store.mjs';

function fakeBackend() {
  const values = new Map();
  return { get: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key), values };
}

test('secret store persists ciphertext only with a real desktop keyring', () => {
  const backend = fakeBackend();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().slice('encrypted:'.length),
  };
  const store = createSecretStore({ safeStorage, backend });
  store.set('llm', 'private-value');
  assert.equal(store.get('llm'), 'private-value');
  assert.equal(String(backend.values.get('llm')).includes('private-value'), false);
  store.delete('llm');
  assert.equal(store.get('llm'), null);
});

test('secret store keeps secrets only in memory without a desktop keyring', () => {
  const backend = fakeBackend();
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
  const store = createSecretStore({ safeStorage, backend });
  store.set('llm', 'session-only');
  assert.equal(store.get('llm'), 'session-only');
  assert.equal(backend.values.size, 0);
});
