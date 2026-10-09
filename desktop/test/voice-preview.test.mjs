import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readVoicePreview } from '../electron/voice-preview.mjs';

test('voice preview reads only an allowed, bounded RIFF/WAVE sample', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-voice-preview-'));
  try {
    const good = path.join(root, 'sample.wav');
    const bad = path.join(root, 'bad.wav');
    const bytes = Buffer.alloc(44);
    bytes.write('RIFF', 0); bytes.write('WAVE', 8);
    await writeFile(good, bytes);
    await writeFile(bad, Buffer.alloc(44));
    assert.equal(await readVoicePreview(good, [good]), `data:audio/wav;base64,${bytes.toString('base64')}`);
    await assert.rejects(readVoicePreview(good, []), /Select a voice sample/);
    await assert.rejects(readVoicePreview(bad, [bad]), /supported WAV/);
    await assert.rejects(readVoicePreview('/etc/passwd', ['/etc/passwd']), /Select a voice sample/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
