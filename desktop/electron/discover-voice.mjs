import path from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

export function findVoiceReferences(root) {
  if (!root) return [];
  const folders = [
    path.join(root, 'data/voices'),
    path.join(root, 'voices'),
    path.join(path.dirname(root), 'cloning'),
  ];
  const found = [];
  for (const folder of folders) {
    let names;
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.wav')) continue;
      if (path.basename(folder) === 'cloning' && !name.startsWith('voice_reference_')) continue;
      const wav = path.join(folder, name);
      const transcript = path.join(folder, `${name.slice(0, -4)}.txt`);
      try {
        const text = readFileSync(transcript, 'utf8').trim();
        const info = statSync(wav);
        if (text && info.isFile()) found.push({ wav, text, modified: info.mtimeMs });
      } catch { /* Ignore files without a paired transcript. */ }
    }
  }
  found.sort((a, b) => b.modified - a.modified || a.wav.localeCompare(b.wav));
  return found.map(({ wav, text }) => ({ wav, text }));
}
