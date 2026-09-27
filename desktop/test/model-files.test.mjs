import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedModelReady } from '../electron/prerequisites.mjs';

test('cached model requires actual config and all indexed weight shards', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lt-model-'));
  try {
    const snapshot = path.join(root, 'snapshots', 'revision');
    mkdirSync(snapshot, { recursive: true });
    assert.equal(cachedModelReady(root), false);
    for (const name of ['config.json', 'tokenizer_config.json', 'preprocessor_config.json']) writeFileSync(path.join(snapshot, name), '{}');
    writeFileSync(path.join(snapshot, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { a: 'one.safetensors', b: 'two.safetensors' } }));
    writeFileSync(path.join(snapshot, 'one.safetensors'), 'weights');
    assert.equal(cachedModelReady(root), false);
    writeFileSync(path.join(snapshot, 'two.safetensors'), 'weights');
    assert.equal(cachedModelReady(root), true);
    assert.equal(cachedModelReady(root, true), false, 'TTS also needs the speech tokenizer weights');
    mkdirSync(path.join(snapshot, 'speech_tokenizer'));
    writeFileSync(path.join(snapshot, 'speech_tokenizer/config.json'), '{}');
    writeFileSync(path.join(snapshot, 'speech_tokenizer/model.safetensors'), 'weights');
    assert.equal(cachedModelReady(root, true), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
