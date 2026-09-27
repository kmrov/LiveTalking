import { createWebRtcClient } from './webrtc-client.mjs';
import { createConversationClient } from './conversation-client.mjs';
import { createAsrClient } from './asr-client.mjs';

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
let webRtcClient;
let serviceReady = false;
let conversationClient;
let recording = false;
let recordingBusy = false;
let sending = false;
let asrClient;
let microphoneState = 'idle';

function showMicrophoneState(state, detail = '') {
  microphoneState = state;
  const labels = { idle: 'Нажмите, чтобы говорить', starting: 'Открываем микрофон…', capturing: 'Говорите; затем нажмите Стоп', transcribing: 'Распознавание…', ready: 'Текст готов к отправке', empty: 'Речь не распознана', failed: 'Ошибка микрофона / ASR' };
  $('#microphone-state').textContent = detail || labels[state] || state;
  $('#microphone-button').textContent = state === 'capturing' ? 'Стоп' : 'Микрофон';
  $('#microphone-button').disabled = !serviceReady || ['starting', 'transcribing'].includes(state);
}

function updateConversationControls() {
  const active = Boolean(webRtcClient?.sessionId());
  $('#send-message').disabled = !active || sending || !$('#message-text').value.trim();
  $('#interrupt-avatar').disabled = !active;
  $('#record-avatar').disabled = !active || recordingBusy;
  if (!active) recording = false;
  $('#record-avatar').textContent = recording ? 'Завершить запись' : 'Записать';
}

function appendMessage(text, type) {
  $('.conversation-empty').hidden = true;
  $('#conversation-list').hidden = false;
  const row = document.createElement('li');
  const label = document.createElement('small');
  label.textContent = type === 'echo' ? 'ВЫ · ОЗВУЧИТЬ' : 'ВЫ · ЧАТ';
  const content = document.createElement('div');
  content.textContent = text;
  row.append(label, content);
  $('#conversation-list').append(row);
  row.scrollIntoView({ block: 'nearest' });
}

function showWebRtcState(state) {
  const labels = { disconnected: 'Нет подключения', connecting: 'Подключение…', negotiating: 'Согласование потока…', connected: 'Поток подключён', reconnecting: 'Переподключение…', failed: 'Ошибка WebRTC', closed: 'Соединение закрыто' };
  $('#webrtc-state').textContent = labels[state] || state;
  $('#connect-avatar').disabled = !serviceReady || ['connecting', 'negotiating'].includes(state);
  const connected = Boolean(webRtcClient?.sessionId());
  $('#connect-avatar').textContent = connected ? 'Отключить' : 'Подключить WebRTC';
  if (['disconnected', 'failed', 'closed'].includes(state)) {
    $('#avatar-video').srcObject = null;
    $('#avatar-audio').srcObject = null;
    $('.stage-empty').hidden = false;
  }
  updateConversationControls();
}

function receiveTrack(event) {
  const target = event.track.kind === 'video' ? $('#avatar-video') : $('#avatar-audio');
  target.srcObject = event.streams[0] || new MediaStream([event.track]);
  if (event.track.kind === 'video') {
    target.hidden = false;
    $('.stage-empty').hidden = true;
  }
}

function disconnectAvatar() {
  webRtcClient?.disconnect();
  webRtcClient = null;
  conversationClient = null;
  showWebRtcState('disconnected');
}
const phaseLabels = {
  'not-configured': 'Не настроено', checking: 'Проверка', starting: 'Запуск',
  ready: 'Работает', reconnecting: 'Переподключение', failed: 'Ошибка',
};
const stageLabels = { stopped: 'Ожидает', starting: 'Запуск', ready: 'Работает', failed: 'Ошибка' };

function showSnapshot(snapshot) {
  const phase = snapshot.service.phase;
  serviceReady = phase === 'ready';
  $('#connect-avatar').disabled = !serviceReady;
  if (!serviceReady && webRtcClient) disconnectAvatar();
  if (!serviceReady && asrClient) { asrClient.dispose(); asrClient = null; }
  showMicrophoneState(microphoneState);
  $('#runtime-state').textContent = phaseLabels[phase] || phase;
  $('#start-profile').disabled = ['checking', 'starting', 'ready'].includes(phase);
  $('#stop-profile').disabled = ['not-configured'].includes(phase);
  for (const stage of ['livetalking', 'asr', 'tts']) {
    const state = snapshot.supervisor?.stages?.[stage] || 'stopped';
    $(`#${stage}-state`).textContent = stageLabels[state] || state;
  }
  $('#runtime-log').textContent = snapshot.supervisor?.logExcerpt || snapshot.service.detail || 'Нет сообщений';
  if (phase === 'failed') message(snapshot.service.detail || 'Сервис завершился с ошибкой');
}

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
  if (file) {
    fields.voice.value = file;
    $('#known-voices').value = file;
  }
});

$('#start-profile').addEventListener('click', async () => {
  try {
    const results = await checkSetup();
    if (!results || results.some(result => result.state !== 'ready')) return;
    currentProfile = await bridge.saveProfile(formProfile());
    message('Запускаем сервисы…');
    await bridge.startProfile(currentProfile.id);
  } catch (error) { message(error.message); }
});
$('#stop-profile').addEventListener('click', async () => {
  try { await bridge.stopProfile(); } catch (error) { message(error.message); }
});
$('#connect-avatar').addEventListener('click', async () => {
  if (webRtcClient?.sessionId()) { disconnectAvatar(); return; }
  if (!serviceReady || !currentProfile) return;
  webRtcClient = createWebRtcClient({
    RTCPeerConnection: window.RTCPeerConnection,
    fetch: window.fetch.bind(window),
    baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
    onState: showWebRtcState,
    onTrack: receiveTrack,
  });
  conversationClient = createConversationClient({
    fetch: window.fetch.bind(window),
    baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
    getSessionId: () => webRtcClient?.sessionId(),
  });
  try {
    await webRtcClient.connect({
      avatarId: currentProfile.liveTalking.avatarId,
      referenceWav: currentProfile.speech.referenceWav,
      referenceText: currentProfile.speech.referenceText,
    });
  } catch (error) { $('#webrtc-state').textContent = `WebRTC: ${error.message}`; }
});
$('#message-text').addEventListener('input', updateConversationControls);
$('#microphone-button').addEventListener('click', async () => {
  try {
    if (microphoneState === 'capturing') { await asrClient.stop(); return; }
    if (!serviceReady || !currentProfile) return;
    if (conversationClient && webRtcClient?.sessionId()) await conversationClient.interrupt();
    asrClient?.dispose();
    asrClient = createAsrClient({
      getUserMedia: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
      AudioContext: window.AudioContext,
      AudioWorkletNode: window.AudioWorkletNode,
      WebSocket: window.WebSocket,
      baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
      onState: showMicrophoneState,
      onText: text => {
        $('#message-text').value = text;
        $('#conversation-message').textContent = 'Проверьте распознанный текст и нажмите Отправить.';
        updateConversationControls();
      },
    });
    await asrClient.start();
  } catch (error) { showMicrophoneState('failed', error.message); }
});
$('#conversation-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!conversationClient || sending) return;
  const text = $('#message-text').value.trim();
  const type = $('#conversation-mode').value;
  sending = true;
  updateConversationControls();
  try {
    await conversationClient.sendText(text, { type, interrupt: true });
    appendMessage(text, type);
    $('#message-text').value = '';
    $('#conversation-message').textContent = 'Сообщение принято.';
  } catch (error) { $('#conversation-message').textContent = error.message; }
  finally { sending = false; updateConversationControls(); }
});
$('#interrupt-avatar').addEventListener('click', async () => {
  try {
    await conversationClient.interrupt();
    $('#conversation-message').textContent = 'Озвучивание прервано.';
  } catch (error) { $('#conversation-message').textContent = error.message; }
});
$('#record-avatar').addEventListener('click', async () => {
  if (recordingBusy) return;
  recordingBusy = true;
  updateConversationControls();
  try {
    if (!recording) {
      await conversationClient.startRecording();
      recording = true;
      $('#conversation-message').textContent = 'Запись идёт…';
    } else {
      const sessionId = webRtcClient.sessionId();
      await conversationClient.stopRecording();
      recording = false;
      updateConversationControls();
      const saved = await bridge.saveRecording(sessionId);
      $('#conversation-message').textContent = saved ? `Сохранено: ${saved}` : 'Запись завершена. Сохранение отменено.';
    }
  } catch (error) { $('#conversation-message').textContent = error.message; }
  finally { recordingBusy = false; updateConversationControls(); }
});
let speakingPollBusy = false;
const speakingTimer = setInterval(async () => {
  if (!conversationClient || !webRtcClient?.sessionId() || speakingPollBusy) return;
  speakingPollBusy = true;
  try { $('#speaking-state').textContent = await conversationClient.speaking() ? 'Говорит' : 'Слушает'; }
  catch { $('#speaking-state').textContent = 'Нет статуса'; }
  finally { speakingPollBusy = false; }
}, 1000);
window.addEventListener('beforeunload', () => { clearInterval(speakingTimer); asrClient?.dispose(); });
window.addEventListener('beforeunload', disconnectAvatar);

if (bridge) {
  bridge.onSnapshot(showSnapshot);
  bridge.getSnapshot().then(showSnapshot).catch(error => message(error.message));
  bridge.getSetup().then(async ({ profile, voiceReferences, recoveryError }) => {
    showProfile(profile);
    showKnownVoices(voiceReferences);
    if (recoveryError) message(recoveryError);
    await checkSetup();
  }).catch(error => message(error.message));
}
