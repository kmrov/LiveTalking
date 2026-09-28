import { createWebRtcClient } from './webrtc-client.mjs';
import { createConversationClient } from './conversation-client.mjs';
import { createAsrClient } from './asr-client.mjs';
import { FixturePeer } from './fixture-peer.mjs';
import { reduceBrainEvent } from './brain-events.mjs';

const bridge = window.liveTalkingDesktop;
if (bridge?.version) document.querySelector('#app-version').textContent = `v0.1 · API ${bridge.version}`;

const $ = selector => document.querySelector(selector);
const fields = {
  python: $('#python-path'), model: $('#avatar-model'), avatarId: $('#avatar-id'), port: $('#server-port'),
  mode: $('#speech-mode'), asrVllm: $('#asr-vllm'), ttsVllm: $('#tts-vllm'),
  asrUrl: $('#asr-url'), ttsUrl: $('#tts-url'), voice: $('#voice-wav'),
  transcript: $('#voice-text'), autoStart: $('#auto-start'),
  brainMode: $('#brain-mode'), brainManaged: $('#brain-service-mode'), brainUrl: $('#brain-url'),
  brainRoot: $('#brain-root'), brainPython: $('#brain-python'), brainDatabase: $('#brain-database-mode'),
  brainFolder: $('#brain-folder'), brainKey: $('#brain-key'), brainDatabaseUrl: $('#brain-database-url'),
};
let currentProfile;
let knownVoices = [];
let webRtcClient;
let serviceReady = false;
let testFixture = false;
let conversationClient;
let recording = false;
let recordingBusy = false;
let sending = false;
let asrClient;
let microphoneState = 'idle';
let brainSource;
let brainState = { conversationId: '', turns: {}, pending: 0 };
let historyGeneration = 0;
let speechInterrupted = false;
let failedTurn;
const submittedTurns = new Map();

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

function appendMessage(text, type, { role = 'user', requestId = '' } = {}) {
  $('.conversation-empty').hidden = true;
  $('#conversation-list').hidden = false;
  const row = document.createElement('li');
  row.dataset.role = role;
  row.dataset.requestId = requestId;
  const label = document.createElement('small');
  label.textContent = role === 'assistant' ? 'БАТЯ' : type === 'echo' ? 'ВЫ · ОЗВУЧИТЬ' : 'ВЫ · ЧАТ';
  const content = document.createElement('div');
  content.textContent = text;
  row.append(label, content);
  $('#conversation-list').append(row);
  row.scrollIntoView({ block: 'nearest' });
  return row;
}

function showWebRtcState(state) {
  const labels = { disconnected: 'Нет подключения', connecting: 'Подключение…', negotiating: 'Согласование потока…', connected: 'Поток подключён', reconnecting: 'Переподключение…', failed: 'Ошибка WebRTC', closed: 'Соединение закрыто' };
  $('#webrtc-state').textContent = labels[state] || state;
  $('#webrtc-state').dataset.sessionId = webRtcClient?.sessionId() || '';
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
  brainSource?.close(); brainSource = null;
  $('#brain-turn-state').dataset.stream = 'closed';
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
  const wasReady = serviceReady;
  const phase = snapshot.service.phase;
  serviceReady = phase === 'ready';
  $('#setup-title').textContent = serviceReady ? 'Профиль запущен' : 'Локальное окружение';
  if (serviceReady) { $('#setup-details').open = false; $('#check-details').open = false; }
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
  for (const stage of ['batya', 'database']) $(`#${stage}-state`).textContent = stageLabels[snapshot.brain?.stages?.[stage] || 'stopped'] || 'Ожидает';
  $('#runtime-log').textContent = [snapshot.brain?.logExcerpt, snapshot.supervisor?.logExcerpt, snapshot.service.detail].filter(Boolean).join('\n') || 'Нет сообщений';
  if (serviceReady && !wasReady && currentProfile?.brain.mode === 'batya') void refreshConversations().catch(error => { $('#conversation-message').textContent = error.message; });
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

function showBrainMode() {
  const batya = fields.brainMode.value === 'batya';
  $('#brain-settings').hidden = !batya;
  $('#brain-managed-fields').hidden = fields.brainManaged.value !== 'managed';
  $('#brain-conversations').hidden = !batya;
  $('#brain-library').hidden = !batya;
  document.querySelectorAll('.brain-service').forEach(row => { row.hidden = !batya; });
  $('#conversation-mode option[value="chat"]').textContent = batya ? 'Чат с Батей' : 'Чат с LLM';
}

function showSecretStatus(status) {
  $('#brain-secret-status').textContent = `${status.apiKeyConfigured ? 'Ключ настроен.' : 'Ключ не задан.'} ${status.persistent ? 'Введённые ключи сохраняются в системном хранилище.' : 'Введённые ключи хранятся до закрытия приложения; для постоянных настроек можно использовать .env Бати.'}`;
}

function showProfile(profile) {
  currentProfile = profile;
  $('#profile-name').textContent = profile.name;
  $('#root-path').textContent = profile.liveTalking.root || 'Не найден рядом с приложением';
  fields.python.value = profile.liveTalking.python;
  fields.model.value = profile.liveTalking.model;
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
  fields.brainMode.value = profile.brain.mode;
  fields.brainManaged.value = profile.brain.managed ? 'managed' : 'external';
  fields.brainUrl.value = profile.brain.url;
  fields.brainRoot.value = profile.brain.root;
  fields.brainPython.value = profile.brain.python;
  fields.brainDatabase.value = profile.brain.databaseMode;
  fields.brainFolder.value = profile.brain.folderId;
  brainState = { conversationId: profile.brain.conversationId, turns: {}, pending: 0 };
  showMode();
  showBrainMode();
}

function formProfile() {
  return {
    ...currentProfile,
    liveTalking: {
      ...currentProfile.liveTalking,
      python: fields.python.value,
      model: fields.model.value,
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
    brain: { ...currentProfile.brain, mode: fields.brainMode.value,
      managed: fields.brainManaged.value === 'managed', url: fields.brainUrl.value,
      root: fields.brainRoot.value, python: fields.brainPython.value,
      databaseMode: fields.brainDatabase.value, folderId: fields.brainFolder.value },
  };
}

async function saveCurrentProfile() {
  currentProfile = await bridge.saveProfile(formProfile());
  const status = await bridge.setBrainSecrets(currentProfile.id, { apiKey: fields.brainKey.value, databaseUrl: fields.brainDatabaseUrl.value });
  fields.brainKey.value = ''; fields.brainDatabaseUrl.value = '';
  showSecretStatus(status);
  return currentProfile;
}

function clearConversation() {
  $('#conversation-list').replaceChildren();
  $('#conversation-list').hidden = true;
  $('.conversation-empty').hidden = false;
  brainState = { conversationId: currentProfile.brain.conversationId, turns: {}, pending: 0 };
  failedTurn = null; submittedTurns.clear(); $('#retry-message').hidden = true;
}

async function loadHistory(identifier) {
  const token = ++historyGeneration;
  if (!identifier) { clearConversation(); return; }
  const messages = await bridge.brainHistory(currentProfile.id, identifier);
  if (token !== historyGeneration || currentProfile.brain.conversationId !== identifier) return;
  clearConversation();
  for (const item of messages) {
    appendMessage(item.text, 'chat', { role: item.role, requestId: item.request_id });
    if (item.role === 'user') submittedTurns.set(item.request_id, { text: item.text, type: 'chat', requestId: item.request_id });
  }
}

async function refreshConversations() {
  if (!currentProfile || currentProfile.brain.mode !== 'batya') return;
  const conversations = await bridge.brainConversations(currentProfile.id);
  const select = $('#brain-conversation');
  select.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Новый разговор'; select.append(blank);
  for (const conversation of conversations) {
    const option = document.createElement('option'); option.value = conversation.id;
    option.textContent = `${new Date(conversation.updated_at || conversation.created_at).toLocaleString('ru-RU')} · ${conversation.id.slice(0, 8)}`;
    select.append(option);
  }
  select.value = currentProfile.brain.conversationId;
  await loadHistory(currentProfile.brain.conversationId);
}

async function newConversation() {
  disconnectAvatar();
  const conversation = await bridge.createBrainConversation(currentProfile.id);
  currentProfile.brain.conversationId = conversation.id;
  await refreshConversations();
}

function receiveBrainEvent(event) {
  const next = reduceBrainEvent(brainState, event);
  if (next === brainState) return;
  brainState = next;
  const turn = brainState.turns[event.request_id];
  if (['delta', 'reset', 'done', 'error'].includes(event.event)) {
    let row = [...$('#conversation-list').children].find(item => item.dataset.role === 'assistant' && item.dataset.requestId === event.request_id);
    if (!row) row = appendMessage('', 'chat', { role: 'assistant', requestId: event.request_id });
    row.dataset.status = turn.status;
    row.querySelector('div').textContent = turn.error || turn.text || '…';
    row.querySelector('small').textContent = turn.status === 'delta' ? 'БАТЯ · ОТВЕЧАЕТ' : turn.status === 'error' ? 'БАТЯ · ОШИБКА' : 'БАТЯ';
    row.scrollIntoView({ block: 'nearest' });
  }
  if (event.event === 'error') { failedTurn = submittedTurns.get(event.request_id); $('#retry-message').hidden = !failedTurn; }
  if (!brainState.pending) speechInterrupted = false;
  $('#brain-turn-state').textContent = brainState.pending
    ? speechInterrupted ? 'Речь остановлена; Батя завершает запись ответа…' : event.event === 'delta' ? 'Батя отвечает…' : 'Батя думает…'
    : 'Батя ожидает';
}

function connectBrainEvents() {
  brainSource?.close();
  if (currentProfile.brain.mode !== 'batya') return;
  brainSource = new EventSource(`http://127.0.0.1:${currentProfile.liveTalking.port}/sse?sessionid=${encodeURIComponent(webRtcClient.sessionId())}`);
  brainSource.onopen = () => { $('#brain-turn-state').dataset.stream = 'connected'; };
  brainSource.onmessage = message => { try { receiveBrainEvent(JSON.parse(message.data)); } catch { /* Other LiveTalking events can share this stream. */ } };
  brainSource.onerror = () => { $('#brain-turn-state').textContent = 'Переподключаем поток ответов…'; };
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
    $('#check-details').open = missing > 0;
    message(missing ? `Нужно исправить: ${missing}` : 'Все проверки пройдены. Профиль готов к запуску.');
    return results;
  } catch (error) { message(error.message); return null; }
}

fields.mode.addEventListener('change', showMode);
fields.brainMode.addEventListener('change', showBrainMode);
fields.brainManaged.addEventListener('change', showBrainMode);
$('#choose-brain-root').addEventListener('click', async () => {
  const root = await bridge.chooseBrainRoot();
  if (root) { fields.brainRoot.value = root; fields.brainPython.value = `${root}/.venv/bin/python`; }
});
$('#new-brain-conversation').addEventListener('click', () => { void newConversation().catch(error => { $('#conversation-message').textContent = error.message; }); });
$('#refresh-brain-conversations').addEventListener('click', () => { void refreshConversations().catch(error => { $('#conversation-message').textContent = error.message; }); });
$('#brain-conversation').addEventListener('change', async () => {
  try {
    disconnectAvatar();
    currentProfile.brain.conversationId = $('#brain-conversation').value;
    await bridge.saveProfile(currentProfile);
    await loadHistory(currentProfile.brain.conversationId);
  } catch (error) { $('#conversation-message').textContent = error.message; }
});
$('#refresh-memories').addEventListener('click', async () => {
  try {
    const memories = await bridge.brainMemories(currentProfile.id);
    $('#brain-memories').replaceChildren();
    for (const memory of memories) { const row = document.createElement('li'); row.textContent = memory.text; $('#brain-memories').append(row); }
    $('#brain-library-message').textContent = memories.length ? `Записей: ${memories.length}` : 'Память пока пуста.';
  } catch (error) { $('#brain-library-message').textContent = error.message; }
});
$('#brain-document-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await bridge.brainDocument(currentProfile.id, { title: $('#brain-document-title').value, source: $('#brain-document-source').value, content: $('#brain-document-content').value });
    $('#brain-library-message').textContent = 'Документ добавлен в Батю.';
    $('#brain-document-content').value = '';
  } catch (error) { $('#brain-library-message').textContent = error.message; }
});
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
    await saveCurrentProfile();
    message('Профиль сохранён. Для смены мозга остановите и запустите профиль.');
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
    await saveCurrentProfile();
    const results = await checkSetup();
    if (!results || results.some(result => result.state !== 'ready')) return;
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
  if (currentProfile.brain.mode === 'batya') {
    try {
      if (!currentProfile.brain.conversationId) await newConversation();
      else await loadHistory(currentProfile.brain.conversationId);
    } catch (error) { $('#conversation-message').textContent = error.message; return; }
  }
  webRtcClient = createWebRtcClient({
    RTCPeerConnection: testFixture ? FixturePeer : window.RTCPeerConnection,
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
      conversationId: currentProfile.brain.mode === 'batya' ? currentProfile.brain.conversationId : '',
    });
    connectBrainEvents();
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
async function submitTurn(turn) {
  if (!conversationClient || sending) return;
  const { text, type, requestId } = turn;
  sending = true;
  updateConversationControls();
  submittedTurns.set(requestId, turn);
  if (![...$('#conversation-list').children].some(row => row.dataset.role === 'user' && row.dataset.requestId === requestId)) appendMessage(text, type, { requestId });
  try {
    speechInterrupted = type === 'echo' && brainState.pending > 0;
    await conversationClient.sendText(text, { type, interrupt: true, requestId });
    failedTurn = null; $('#retry-message').hidden = true;
    $('#message-text').value = '';
    $('#conversation-message').textContent = 'Сообщение принято.';
  } catch (error) { $('#conversation-message').textContent = error.message; failedTurn = turn; $('#retry-message').hidden = false; }
  finally { sending = false; updateConversationControls(); }
}
$('#conversation-form').addEventListener('submit', async event => {
  event.preventDefault();
  await submitTurn({ text: $('#message-text').value.trim(), type: $('#conversation-mode').value, requestId: crypto.randomUUID() });
});
$('#retry-message').addEventListener('click', () => { if (failedTurn) void submitTurn(failedTurn); });
$('#interrupt-avatar').addEventListener('click', async () => {
  try {
    await conversationClient.interrupt();
    speechInterrupted = true;
    if (brainState.pending) $('#brain-turn-state').textContent = 'Речь остановлена; Батя завершает запись ответа…';
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
  bridge.getSetup().then(async ({ profile, voiceReferences, secrets, recoveryError, testFixture: fixture }) => {
    testFixture = fixture;
    showProfile(profile);
    showKnownVoices(voiceReferences);
    showSecretStatus(secrets);
    if (recoveryError) { $('#setup-recovery').textContent = recoveryError; $('#setup-recovery').hidden = false; }
    await checkSetup();
    if (serviceReady && currentProfile.brain.mode === 'batya') await refreshConversations();
  }).catch(error => message(error.message));
}
