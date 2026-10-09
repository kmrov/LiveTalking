import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const maxBytes = 25 * 1024 * 1024;

export async function readVoicePreview(wav, allowedPaths) {
  if (typeof wav !== 'string' || !path.isAbsolute(wav) || !/\.wav$/i.test(wav) || wav.includes('\0')
    || !allowedPaths.includes(wav)) throw new Error('Select a voice sample before previewing it.');
  const info = await stat(wav);
  if (!info.isFile() || info.size < 44 || info.size > maxBytes) throw new Error('Voice sample must be a WAV file under 25 MB.');
  const bytes = await readFile(wav);
  if (bytes.length > maxBytes || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Voice sample is not a supported WAV file.');
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}
