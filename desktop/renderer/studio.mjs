const bridge = window.liveTalkingDesktop;
if (bridge?.version) document.querySelector('#app-version').textContent = `v0.1 · API ${bridge.version}`;

const $ = selector => document.querySelector(selector);
const fields = {
  python: $('#python-path'), avatarId: $('#avatar-id'), port: $('#server-port'),
  mode: $('#speech-mode'), asrVllm: $('#asr-vllm'), ttsVllm: $('#tts-vllm'),
  asrUrl: $('#asr-url'), ttsUrl: $('#tts-url'), voice: $('#voice-wav'),
  transcript: $('#voice-text'), autoStart: $('#auto-start'),
};
let currentProfile;
let knownVoices = [];

function showKnownVoices(voices) {
  knownVoices = voices;
  const select = $('#known-voices');
  select.replaceChildren();
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.wav;
    option.textContent = voice.wav.split('/').at(-1);
    select.append(option);
  }
  $('#known-voices-label').hidden = voices.length === 0;
  if (voices.some(voice => voice.wav === fields.voice.value)) select.value = fields.voice.value;
}

function showMode() {
  const external = fields.mode.value === 'external';
  $('#local-model-fields').hidden = external;
  $('#external-model-fields').hidden = !external;
}

function showProfile(profile) {
  currentProfile = profile;
  $('#root-path').textContent = profile.liveTalking.root || 'Не найден рядом с приложением';
  fields.python.value = profile.liveTalking.python;
  fields.avatarId.value = profile.liveTalking.avatarId;
  fields.port.value = profile.liveTalking.port;
  fields.mode.value = profile.speech.mode;
  fields.asrVllm.value = profile.speech.asrVllm;
  fields.ttsVllm.value = profile.speech.ttsVllm;
  fields.asrUrl.value = profile.speech.asrUrl;
  fields.ttsUrl.value = profile.speech.ttsUrl;
  fields.voice.value = profile.speech.referenceWav;
  fields.transcript.value = profile.speech.referenceText;
  fields.autoStart.checked = profile.autoStart;
  showMode();
}

function formProfile() {
  return {
    ...currentProfile,
    liveTalking: {
      ...currentProfile.liveTalking,
      python: fields.python.value,
      avatarId: fields.avatarId.value,
      port: Number(fields.port.value),
    },
    speech: {
      ...currentProfile.speech,
      mode: fields.mode.value,
      asrVllm: fields.asrVllm.value,
      ttsVllm: fields.ttsVllm.value,
      asrUrl: fields.asrUrl.value,
      ttsUrl: fields.ttsUrl.value,
      referenceWav: fields.voice.value,
      referenceText: fields.transcript.value,
    },
    autoStart: fields.autoStart.checked,
  };
}

function message(text) { $('#setup-message').textContent = text; }

function showResults(results) {
  const list = $('#setup-results');
  list.replaceChildren();
  for (const result of results) {
    const row = document.createElement('li');
    row.dataset.state = result.state;
    const title = document.createElement('strong');
    title.textContent = `${result.state === 'ready' ? '✓' : result.state === 'blocked' ? '!' : '○'} ${result.detail}`;
    row.append(title);
    if (result.action) {
      const action = document.createElement('span');
      action.textContent = result.action;
      row.append(action);
    }
    list.append(row);
  }
}

async function checkSetup() {
  message('Проверяем окружение…');
  try {
    const results = await bridge.checkSetup(formProfile());
    showResults(results);
    const missing = results.filter(item => item.state !== 'ready').length;
    message(missing ? `Нужно исправить: ${missing}` : 'Все проверки пройдены. Профиль готов к запуску.');
    return results;
  } catch (error) { message(error.message); return null; }
}

fields.mode.addEventListener('change', showMode);
$('#known-voices').addEventListener('change', () => {
  const voice = knownVoices.find(item => item.wav === $('#known-voices').value);
  if (voice) {
    fields.voice.value = voice.wav;
    fields.transcript.value = voice.text;
  }
});
$('#check-setup').addEventListener('click', checkSetup);
$('#setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    currentProfile = await bridge.saveProfile(formProfile());
    message('Профиль сохранён.');
    await checkSetup();
  } catch (error) { message(error.message); }
});
$('#choose-root').addEventListener('click', async () => {
  const selected = await bridge.chooseLiveTalkingRoot();
  if (!selected) return;
  const { root, voiceReferences } = selected;
  const previous = currentProfile.liveTalking.root;
  currentProfile.liveTalking.root = root;
  if (!fields.python.value || fields.python.value === `${previous}/.venv/bin/python`) fields.python.value = `${root}/.venv/bin/python`;
  $('#root-path').textContent = root;
  showKnownVoices(voiceReferences);
  if (voiceReferences.length) {
    fields.voice.value = voiceReferences[0].wav;
    fields.transcript.value = voiceReferences[0].text;
  }
  await checkSetup();
});
$('#choose-voice').addEventListener('click', async () => {
  const file = await bridge.chooseVoiceWav();
  if (file) fields.voice.value = file;
});

if (bridge) {
  bridge.getSetup().then(async ({ profile, voiceReferences, recoveryError }) => {
    showProfile(profile);
    showKnownVoices(voiceReferences);
    if (recoveryError) message(recoveryError);
    await checkSetup();
  }).catch(error => message(error.message));
}
