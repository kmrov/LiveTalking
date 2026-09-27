import path from 'node:path';
import { existsSync } from 'node:fs';

function isCheckout(root, exists) {
  return exists(path.join(root, 'app.py')) && exists(path.join(root, 'config.py'));
}

export function discoverLiveTalkingRoot({ appPath, executablePath, appImagePath, override, exists = existsSync }) {
  if (override) return path.resolve(override);
  const candidates = [];
  if (appImagePath) {
    candidates.push(path.join(path.dirname(appImagePath), 'LiveTalking'));
  } else {
    if (appPath) candidates.push(path.dirname(appPath));
    if (executablePath) candidates.push(path.join(path.dirname(executablePath), 'LiveTalking'));
  }
  return candidates.find(root => isCheckout(root, exists)) ?? null;
}
