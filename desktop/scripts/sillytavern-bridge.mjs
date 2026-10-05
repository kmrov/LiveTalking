import { createSillyTavernClient } from '../electron/sillytavern-client.mjs';
import { createSillyTavernBridge } from '../electron/sillytavern-bridge.mjs';
import { DEFAULT_SILLYTAVERN_CHARACTER, sillyTavernCharacter } from '../src/sillytavern-character.mjs';

const port = Number(process.env.STUDIO_ST_BRIDGE_PORT || 8002);
const client = createSillyTavernClient({ baseUrl: process.env.STUDIO_ST_URL || 'http://127.0.0.1:8001' });
await client.version();
const avatar = sillyTavernCharacter(process.env.STUDIO_ST_AVATAR);
if (avatar === DEFAULT_SILLYTAVERN_CHARACTER) await client.ensureCard();
else await client.character(avatar);
const bridge = createSillyTavernBridge({ client, apiKey: process.env.YANDEX_AISTUDIO_KEY,
  folderId: process.env.YANDEX_FOLDER_ID, model: process.env.PERSONA_SPEECH_MODEL || 'qwen3.6-35b-a3b',
  avatar,
  stUrl: process.env.STUDIO_ST_URL || 'http://127.0.0.1:8001' });
bridge.server.listen(port, '127.0.0.1', () => process.stdout.write(`SillyTavern bridge ready on 127.0.0.1:${port}\n`));
