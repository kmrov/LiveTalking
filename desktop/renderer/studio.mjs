import { createWebRtcClient } from './webrtc-client.mjs';
import { createProjectionClient } from './projection-client.mjs';
import { createConversationClient } from './conversation-client.mjs';
import { createAsrClient } from './asr-client.mjs';
import { createContinuousVoiceClient } from './continuous-voice-client.mjs';
import { waitForAvatarReply, waitForSendSlot } from './auto-turn.mjs';
import { FixturePeer } from './fixture-peer.mjs';
import { reduceBrainEvent } from './brain-events.mjs';
import { mountAvatarLibrary } from './avatar-library.mjs';
import { mountPanelResizers } from './panel-resize.mjs';

const bridge = window.liveTalkingDesktop;
if (bridge?.version) document.querySelector('#app-version').textContent = `v0.1 · API ${bridge.version}`;

const $ = selector => document.querySelector(selector);
mountPanelResizers({
  workspace: $('.workspace'), leftPanel: $('.left-panel'), rightPanel: $('.right-panel'),
  leftHandle: $('#left-panel-resizer'), rightHandle: $('#right-panel-resizer'),
});
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
let avatarUI;
let servicePhase = "not-configured";
let latestRuntimeSnapshot;
let sessionGeneration = 0;
let knownVoices = [];
let webRtcClient;
let projectionClient;
let projectionBusy = false;
let discoveryPending = false;
let previewBusy = false;
let connectionGeneration = 0;
let webRtcState = 'disconnected';
let activeTarget = 'none';
let serviceReady = false;
let testFixture = false;
let conversationClient;
let recording = false;
let recordingBusy = false;
let sending = false;
let conversationChangeBusy = false;
let asrClient;
let microphoneState = 'idle';
let microphoneGeneration = 0;
let continuousVoiceClient;
let brainSource;
let brainState = { conversationId: '', turns: {}, pending: 0 };
let brainEventVersion = 0;
let historyGeneration = 0;
let speechInterrupted = false;
let failedTurn;
const submittedTurns = new Map();

function activeSessionId() {
  return activeTarget === 'projection' ? projectionClient?.sessionId() : activeTarget === 'preview' ? webRtcClient?.sessionId() : null;
}

function selectConversationTarget(target) {
  if (activeTarget !== target && continuousVoiceClient) void stopContinuousVoice();
  ++sessionGeneration;
  brainSource?.close(); brainSource = null;
  $('#brain-turn-state').dataset.stream = 'closed';
  activeTarget = target;
  const sessionId = activeSessionId();
  conversationClient = sessionId ? createConversationClient({
    fetch: window.fetch.bind(window), idempotentChat: currentProfile.brain.mode === 'persona',
    baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
    getSessionId: activeSessionId,
  }) : null;
  if (sessionId) connectBrainEvents();
  updateConversationControls();
}

function showMicrophoneState(state, detail = '') {
  microphoneState = state;
  const labels = { idle: 'Press to speak', starting: 'Opening microphone…', capturing: 'Speak, then press Stop', transcribing: 'Transcribing…', ready: 'Text ready to send', empty: 'No speech recognized', failed: 'Microphone / ASR error' };
  $('#microphone-state').textContent = detail || labels[state] || state;
  $('#microphone-button').textContent = state === 'capturing' ? 'Stop' : 'Microphone';
  $('#microphone-button').disabled = !serviceReady || conversationChangeBusy || Boolean(continuousVoiceClient) || ['starting', 'transcribing'].includes(state);
}

function showContinuousVoiceState(state, detail = '') {
  const labels = { idle: 'Auto conversation is off', starting: 'Opening microphone and ASR…', listening: 'Listening: speak freely',
    capturing: 'Phrase detected; sending after a pause', transcribing: 'Transcribing phrase…', waiting: 'Waiting for avatar response', failed: 'Auto conversation error' };
  $('#handsfree-state').dataset.state = state;
  $('#handsfree-state').textContent = detail || labels[state] || state;
  const level = $('#handsfree-level');
  level.hidden = !['listening', 'capturing'].includes(state) && !(state === 'waiting' && $('#handsfree-barge-in').checked);
  if (state === 'listening') level.textContent = 'Input: waiting for signal';
  $('#handsfree-button').textContent = continuousVoiceClient && state !== 'failed' ? 'Stop auto conversation' : 'Auto conversation';
  $('#handsfree-barge-in').disabled = Boolean(continuousVoiceClient);
  updateConversationControls();
  showMicrophoneState(microphoneState);
}

async function stopContinuousVoice() {
  const client = continuousVoiceClient;
  continuousVoiceClient = null;
  if (client) await client.stop();
  showContinuousVoiceState('idle');
}

function updateConversationControls() {
  const active = Boolean(activeSessionId());
  $('#handsfree-button').disabled = conversationChangeBusy || (!continuousVoiceClient && (!serviceReady || !active));
  $('#send-message').disabled = conversationChangeBusy || !active || sending || !$('#message-text').value.trim();
  $('#interrupt-avatar').disabled = !active;
  $('#record-avatar').disabled = !active || recordingBusy || conversationChangeBusy;
  if (!active) { recording = false; $('#speaking-state').textContent = 'Disconnected'; }
  $('#record-avatar').textContent = recording ? 'Finish recording' : 'Record MP4';
  avatarUI?.applySnapshot();
}

function appendMessage(text, type, { role = 'user', requestId = '' } = {}) {
  $('.conversation-empty').hidden = true;
  $('#conversation-list').hidden = false;
  const row = document.createElement('li');
  row.dataset.role = role;
  row.dataset.requestId = requestId;
  const label = document.createElement('small');
  label.textContent = role === 'assistant' ? 'PERSONA' : type === 'echo' ? 'YOU · SPEAK' : 'YOU · CHAT';
  const content = document.createElement('div');
  content.textContent = text;
  row.append(label, content);
  $('#conversation-list').append(row);
  row.scrollIntoView({ block: 'nearest' });
  return row;
}

function showWebRtcState(state) {
  webRtcState = state;
  const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', negotiating: 'Negotiating stream…', connected: 'Stream connected', reconnecting: 'Reconnecting…', failed: 'WebRTC error', closed: 'Connection closed' };
  $('#webrtc-state').textContent = labels[state] || state;
  $('#webrtc-state').dataset.sessionId = webRtcClient?.sessionId() || '';
  $('#connect-avatar').disabled = !serviceReady || previewBusy || projectionBusy || Boolean(projectionClient?.sessionId());
  $('#connect-projection').disabled = !serviceReady || previewBusy || projectionBusy || Boolean(webRtcClient?.sessionId());
  updateProjectionHint();
  const connected = Boolean(webRtcClient?.sessionId());
  $('#connect-avatar').textContent = connected ? 'Disconnect preview' : 'Enable preview';
  if (['disconnected', 'failed', 'closed'].includes(state)) {
    if (activeTarget === 'preview') selectConversationTarget('none');
    $('#avatar-video').srcObject = null;
    $('#avatar-audio').srcObject = null;
    $('.stage-empty').hidden = false;
  }
  updateConversationControls();
  updateWorkflowHint();
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
  ++connectionGeneration;
  previewBusy = false;
  if (activeTarget === 'preview') selectConversationTarget('none');
  webRtcClient?.disconnect();
  webRtcClient = null;
  showWebRtcState('disconnected');
}

function showProjectionState(state) {
  const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Stream connected', failed: 'Error', closed: 'Connection closed' };
  $('#projection-state').textContent = labels[state] || state;
  $('#projection-state').dataset.sessionId = projectionClient?.sessionId() || '';
  $('#connect-projection').textContent = projectionClient?.sessionId() ? 'Disconnect projection' : 'Connect projection';
  $('#connect-projection').disabled = !serviceReady || projectionBusy || previewBusy || Boolean(webRtcClient?.sessionId());
  $('#connect-avatar').disabled = !serviceReady || projectionBusy || previewBusy || Boolean(projectionClient?.sessionId());
  updateProjectionHint();
  if (activeTarget === 'projection' && !projectionClient?.sessionId()) selectConversationTarget('none');
  updateConversationControls();
  updateWorkflowHint();
}
async function refreshHeadinjarDiscovery() {
  if (!bridge || discoveryPending) return;
  discoveryPending = true;
  const profileId = currentProfile?.id;
  const select = $('#projection-discovered');
  try {
    const found = await bridge.projectionRequest(profileId, 'discover');
    if (currentProfile?.id !== profileId) return;
    const selected = select.value;
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = found.length ? 'Select a discovered Head in Jar' : 'No Head in Jar found on the network';
    select.append(placeholder);
    for (const receiver of found) {
      const option = document.createElement('option');
      option.value = receiver.url;
      option.dataset.auth = receiver.auth;
      option.textContent = `${receiver.name} · ${new URL(receiver.url).host}${receiver.auth === 'bearer' ? ' · token required' : ''}`;
      select.append(option);
    }
    select.value = found.some(receiver => receiver.url === selected) ? selected : '';
    updateProjectionHint();
  } catch (error) {
    if (currentProfile?.id === profileId) {
      select.replaceChildren();
      const option = document.createElement('option');
      option.value = '';
      option.textContent = `Discovery unavailable: ${error.message}`;
      select.append(option);
    }
  } finally { discoveryPending = false; }
}

$('#projection-discovered').addEventListener('change', () => {
  const url = $('#projection-discovered').value;
  if (url) { $('#projection-url').value = url; $('#projection-token').value = ''; }
  updateProjectionHint();
});
$('#projection-url').addEventListener('input', () => {
  if ($('#projection-url').value !== $('#projection-discovered').value) $('#projection-discovered').value = '';
  updateProjectionHint();
});

function updateProjectionHint() {
  const selected = $('#projection-discovered').selectedOptions[0];
  let hint = $('#projection-discovered').value
    ? selected?.dataset.auth === 'bearer'
      ? 'This Head in Jar requires a bearer token. Copy it from Head in Jar and paste it here.'
      : 'Discovered Head in Jar: connect without a token. Enable the projector there separately.'
    : 'Select Head in Jar from the list or enter a WHIP URL. The token is optional.';
  if (!serviceReady) hint = servicePhase === 'failed' ? 'Profile did not start: check the startup log.'
    : servicePhase === 'starting' || servicePhase === 'checking' ? 'Wait for services to start; connection becomes available when they are Running.'
      : 'Start the Studio profile first.';
  else if (webRtcClient?.sessionId()) hint = 'Disconnect WebRTC preview before connecting projection.';
  else if (projectionBusy || previewBusy) hint = 'Wait for the current connection to finish.';
  else if (projectionClient?.sessionId()) hint = 'Stream connected. Enable the projector in Head in Jar.';
  $('#projection-hint').textContent = hint;
}

function updateWorkflowHint() {
  const hint = $('#workflow-hint');
  const mode = $('#runtime-mode');
  const setup = $('#setup-description');
  const emptyTitle = $('.stage-empty h2');
  const emptyDetail = $('.stage-empty p');
  if (mode) mode.textContent = currentProfile?.brain.mode === 'persona' ? 'Persona mode' : 'Direct LLM';
  if (setup) setup.textContent = activeSessionId()
    ? 'Services are running. Control speech and recording in the conversation panel.'
    : serviceReady ? 'Services are running. Enable preview here or connect Head in Jar for projection.'
    : 'Check your environment and profile, then start services.';
  if (emptyTitle && emptyDetail) {
    emptyTitle.textContent = projectionClient?.sessionId() ? 'Streaming to Head in Jar'
      : webRtcClient?.sessionId() ? 'Waiting for avatar video' : 'Your avatar will appear here';
    emptyDetail.textContent = projectionClient?.sessionId()
      ? 'Studio preview is off. The stream and conversation controls are in Head in Jar.'
      : webRtcClient?.sessionId() ? 'Preview connected. Waiting for video.'
      : 'Enable preview to see the avatar stream in Studio.';
  }
  if (!hint) return;
  hint.textContent = activeSessionId() ? 'Connected · speak or send text.'
    : ['checking', 'starting'].includes(servicePhase) ? 'Services are starting · wait for loading to finish.'
      : serviceReady ? 'Ready · enable preview or connect projection.'
        : servicePhase === 'failed' ? 'Startup failed · check the log and profile.'
          : 'First step · configure the profile and start services.';
}

async function disconnectProjection() {
  ++connectionGeneration;
  projectionBusy = false;
  if (activeTarget === 'projection') selectConversationTarget('none');
  const client = projectionClient;
  projectionClient = null;
  showProjectionState('disconnected');
  if (client) await client.disconnect();
}
const phaseLabels = {
  'not-configured': 'Not configured', checking: 'Checking', starting: 'Starting',
  ready: 'Running', reconnecting: 'Reconnecting', failed: 'Error',
};
const stageLabels = { stopped: 'Idle', waiting: 'Queued', ready: 'Running', failed: 'Error' };
const stageNames = { database: 'PostgreSQL', persona: 'Persona', asr: 'Qwen ASR', tts: 'Qwen TTS', livetalking: 'LiveTalking' };
function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderStartupProgress(snapshot) {
  const phase = snapshot.service.phase;
  const active = [];
  for (const stage of ['database', 'persona', 'asr', 'tts', 'livetalking']) {
    const owner = stage === 'database' || stage === 'persona' ? snapshot.brain : snapshot.supervisor;
    const state = owner?.stages?.[stage] || 'stopped';
    const startedAt = owner?.stageStartedAt?.[stage];
    const label = $(`#${stage}-state`);
    label.dataset.state = state;
    label.textContent = state === 'starting'
      ? `${stage === 'asr' || stage === 'tts' ? 'Loading model' : 'Starting'}${startedAt ? ` · ${formatElapsed(startedAt)}` : ''}`
      : stageLabels[state] || state;
    if (state === 'starting') active.push(stageNames[stage]);
  }
  const isStarting = phase === 'checking' || phase === 'starting';
  $('#startup-progress').hidden = !isStarting;
  if (!isStarting) return;
  const downloading = phase === 'checking' && ['checking', 'downloading'].includes(snapshot.downloads?.state);
  $('#startup-progress-text').textContent = downloading
    ? `${snapshot.downloads.label || 'Downloading models'} · ${Math.round(snapshot.downloads.progress || 0)}%`
    : phase === 'checking' ? 'Checking environment and models…'
      : active.length ? `Starting: ${active.join(', ')}. Connection will be available when all services are ready.`
        : 'Preparing to start services…';
}

function showSnapshot(snapshot) {
  latestRuntimeSnapshot = snapshot;
  const wasReady = serviceReady;
  const phase = snapshot.service.phase;
  servicePhase = phase;
  serviceReady = phase === 'ready';
  if (serviceReady && !wasReady) void refreshHeadinjarDiscovery();
  $('#setup-title').textContent = serviceReady ? 'Profile running' : 'Local environment';
  if (serviceReady && !wasReady) { $('#setup-details').open = false; $('#check-details').open = false; }
  showWebRtcState(webRtcState);
  showProjectionState(projectionClient?.sessionId() ? 'connected' : 'disconnected');
  if (!serviceReady && webRtcClient) disconnectAvatar();
  if (!serviceReady && projectionClient) void disconnectProjection().catch(error => { $('#projection-state').textContent = error.message; });
  if (!serviceReady && continuousVoiceClient) void stopContinuousVoice();
  if (!serviceReady && asrClient) { asrClient.dispose(); asrClient = null; }
  showMicrophoneState(microphoneState);
  const downloading = phase === 'checking' && ['checking', 'downloading'].includes(snapshot.downloads?.state);
  $('#runtime-state').textContent = downloading ? 'Downloading models' : phaseLabels[phase] || phase;
  $('#runtime-state').dataset.phase = phase;
  $('#model-download-panel').hidden = !downloading;
  $('#model-download-progress').value = snapshot.downloads?.progress || 0;
  $('#model-download-state').textContent = downloading
    ? `${snapshot.downloads.label || 'Preparing download'}${snapshot.downloads.totalBytes ? ` · ${Math.round(snapshot.downloads.downloadedBytes / 1048576)} / ${Math.round(snapshot.downloads.totalBytes / 1048576)} MB` : ''}` : '';
  $('#start-profile').disabled = ['checking', 'starting', 'ready'].includes(phase);
  $('#stop-profile').disabled = ['not-configured'].includes(phase);
  renderStartupProgress(snapshot);
  $('#runtime-log').textContent = [snapshot.brain?.logExcerpt, snapshot.supervisor?.logExcerpt, snapshot.service.detail].filter(Boolean).join('\n') || 'No messages';
  if (serviceReady && !wasReady && currentProfile?.brain.mode === 'persona') void refreshConversations().catch(error => { $('#conversation-message').textContent = error.message; });
  avatarUI?.applySnapshot();
  if (phase === 'failed') message(snapshot.service.detail || 'Service failed');
  if (serviceReady && !wasReady && $('#setup-message').textContent === 'Starting services…') message('');
  updateWorkflowHint();
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
  const persona = fields.brainMode.value === 'persona';
  $('#brain-settings').hidden = !persona;
  $('#brain-managed-fields').hidden = fields.brainManaged.value !== 'managed';
  $('#brain-conversations').hidden = !persona;
  $('#brain-library').hidden = !persona;
  document.querySelectorAll('.brain-service').forEach(row => { row.hidden = !persona; });
  $('#conversation-mode option[value="chat"]').textContent = persona ? 'Chat with Persona' : 'Chat with LLM';
}

function showSecretStatus(status) {
  $('#brain-secret-status').textContent = `${status.apiKeyConfigured ? 'API key configured.' : 'API key not configured.'} ${status.persistent ? 'Entered keys are saved in the system keyring.' : 'Entered keys are kept until the app closes; use Persona .env for persistent settings.'}`;
}

function showProfile(profile) {
  currentProfile = profile;
  void refreshHeadinjarDiscovery();
  $('#profile-name').textContent = profile.name;
  $('#root-path').textContent = profile.liveTalking.root || 'Not found beside the app';
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
  updateWorkflowHint();
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
  const eventVersion = brainEventVersion;
  if (!identifier) { clearConversation(); return; }
  if (brainState.conversationId === identifier && brainState.pending) return;
  const messages = await bridge.brainHistory(currentProfile.id, identifier);
  if (token !== historyGeneration || currentProfile.brain.conversationId !== identifier) return;
  if (brainState.conversationId === identifier && (brainState.pending || eventVersion !== brainEventVersion)) return;
  clearConversation();
  for (const item of messages) {
    appendMessage(item.text, 'chat', { role: item.role, requestId: item.request_id });
    if (item.role === 'user') submittedTurns.set(item.request_id, { text: item.text, type: 'chat', requestId: item.request_id });
  }
}

async function refreshConversations() {
  if (!currentProfile || currentProfile.brain.mode !== 'persona') return;
  const conversations = await bridge.brainConversations(currentProfile.id);
  const select = $('#brain-conversation');
  select.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'New conversation'; select.append(blank);
  for (const conversation of conversations) {
    const option = document.createElement('option'); option.value = conversation.id;
    option.textContent = `${new Date(conversation.updated_at || conversation.created_at).toLocaleString('en-US')} · ${conversation.id.slice(0, 8)}`;
    select.append(option);
  }
  select.value = currentProfile.brain.conversationId;
  await loadHistory(currentProfile.brain.conversationId);
}

function updateConversationSelectionControls() {
  $('#new-brain-conversation').disabled = conversationChangeBusy;
  $('#brain-conversation').disabled = conversationChangeBusy;
  $('#refresh-brain-conversations').disabled = conversationChangeBusy;
  updateConversationControls();
  showMicrophoneState(microphoneState);
}

async function applyBrainConversation(identifier) {
  if (continuousVoiceClient) await stopContinuousVoice();
  ++microphoneGeneration;
  asrClient?.dispose(); asrClient = null;
  showMicrophoneState('idle');
  if (activeSessionId()) await conversationClient.setConversation(identifier);
  currentProfile.brain.conversationId = identifier;
  await bridge.saveProfile(currentProfile);
  selectConversationTarget(activeTarget);
  speechInterrupted = false;
  $('#brain-turn-state').textContent = 'Persona is idle';
  await refreshConversations();
}

async function selectBrainConversation(identifier, { keepConnectionAttempt = false } = {}) {
  if (conversationChangeBusy) throw new Error('Wait for the conversation to change.');
  if (recording || recordingBusy) throw new Error('Finish recording before changing conversations.');
  if (sending) throw new Error('Wait for the message to send before changing conversations.');
  if (!keepConnectionAttempt && (projectionBusy || previewBusy)) throw new Error('Wait for the stream to connect.');
  conversationChangeBusy = true;
  updateConversationSelectionControls();
  try {
    await applyBrainConversation(identifier);
  } finally {
    conversationChangeBusy = false;
    updateConversationSelectionControls();
  }
}

async function newConversation({ keepConnectionAttempt = false } = {}) {
  if (conversationChangeBusy) return;
  if (recording || recordingBusy) throw new Error('Finish recording before changing conversations.');
  if (sending) throw new Error('Wait for the message to send before changing conversations.');
  if (!keepConnectionAttempt && (projectionBusy || previewBusy)) throw new Error('Wait for the stream to connect.');
  conversationChangeBusy = true;
  updateConversationSelectionControls();
  try {
    const conversation = await bridge.createBrainConversation(currentProfile.id);
    await applyBrainConversation(conversation.id);
  } finally {
    conversationChangeBusy = false;
    updateConversationSelectionControls();
  }
}

function receiveBrainEvent(event) {
  const next = reduceBrainEvent(brainState, event);
  if (next === brainState) return;
  brainState = next;
  ++brainEventVersion;
  const turn = brainState.turns[event.request_id];
  if (typeof event.user_text === 'string' && ![...$('#conversation-list').children].some(item => item.dataset.role === 'user' && item.dataset.requestId === event.request_id)) {
    appendMessage(event.user_text, 'chat', { role: 'user', requestId: event.request_id });
    submittedTurns.set(event.request_id, { text: event.user_text, type: 'chat', requestId: event.request_id });
  }
  if (['snapshot', 'delta', 'reset', 'done', 'error'].includes(event.event)) {
    let row = [...$('#conversation-list').children].find(item => item.dataset.role === 'assistant' && item.dataset.requestId === event.request_id);
    if (!row) row = appendMessage('', 'chat', { role: 'assistant', requestId: event.request_id });
    row.dataset.status = turn.status;
    row.querySelector('div').textContent = turn.error || turn.text || '…';
    row.querySelector('small').textContent = turn.status === 'delta' ? 'PERSONA · REPLYING' : turn.status === 'error' ? 'PERSONA · ERROR' : 'PERSONA';
    row.scrollIntoView({ block: 'nearest' });
  }
  if (turn.status === 'error') { failedTurn = submittedTurns.get(event.request_id); $('#retry-message').hidden = !failedTurn; }
  if (!brainState.pending) speechInterrupted = false;
  $('#brain-turn-state').textContent = brainState.pending
    ? speechInterrupted ? 'Speech stopped; Persona is saving the response…' : event.event === 'delta' ? 'Persona is replying…' : 'Persona is thinking…'
    : 'Persona is idle';
}

function connectBrainEvents() {
  brainSource?.close();
  if (currentProfile.brain.mode !== 'persona') return;
  brainSource = new EventSource(`http://127.0.0.1:${currentProfile.liveTalking.port}/sse?sessionid=${encodeURIComponent(activeSessionId())}`);
  const source = brainSource;
  const token = sessionGeneration;
  brainSource.onopen = () => { if (source !== brainSource || token !== sessionGeneration) return; $('#brain-turn-state').dataset.stream = 'connected'; };
  brainSource.onmessage = message => { if (source !== brainSource || token !== sessionGeneration) return; try { receiveBrainEvent(JSON.parse(message.data)); } catch { /* Other LiveTalking events can share this stream. */ } };
  brainSource.onerror = () => { if (source !== brainSource || token !== sessionGeneration) return; $('#brain-turn-state').textContent = 'Reconnecting response stream…'; };
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
  message('Checking environment…');
  try {
    const results = await bridge.checkSetup(formProfile());
    showResults(results);
    const missing = results.filter(item => item.state !== 'ready').length;
    const manual = results.filter(item => item.state !== 'ready' && !(item.state === 'missing' && ['avatar-model', 'asr-model', 'tts-model'].includes(item.id))).length;
    $('#check-details').open = missing > 0;
    message(manual ? `Fix: ${manual}` : missing ? 'Models will be downloaded at startup.' : 'All checks passed. The profile is ready to start.');
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
    const identifier = $('#brain-conversation').value;
    if (identifier) await selectBrainConversation(identifier);
    else await newConversation();
  } catch (error) {
    $('#brain-conversation').value = currentProfile.brain.conversationId;
    $('#conversation-message').textContent = error.message;
  }
});
$('#refresh-memories').addEventListener('click', async () => {
  try {
    const memories = await bridge.brainMemories(currentProfile.id);
    $('#brain-memories').replaceChildren();
    for (const memory of memories) { const row = document.createElement('li'); row.textContent = memory.text; $('#brain-memories').append(row); }
    $('#brain-library-message').textContent = memories.length ? `Entries: ${memories.length}` : 'Memory is empty.';
  } catch (error) { $('#brain-library-message').textContent = error.message; }
});
$('#brain-document-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await bridge.brainDocument(currentProfile.id, { title: $('#brain-document-title').value, source: $('#brain-document-source').value, content: $('#brain-document-content').value });
    $('#brain-library-message').textContent = 'Document added to Persona.';
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
    message('Profile saved. Restart it to change the brain.');
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
  await avatarUI?.refresh();
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
    if (!results) return;
    message('Starting services…');
    await bridge.startProfile(currentProfile.id);
  } catch (error) { message(error.message); }
});
$('#stop-profile').addEventListener('click', async () => {
  if (recording || recordingBusy) { $('#conversation-message').textContent = 'Finish recording before stopping the profile.'; return; }
  try { await disconnectProjection(); } catch (error) { $('#projection-state').textContent = error.message; }
  try { await bridge.stopProfile(); } catch (error) { message(error.message); }
});
$('#connect-avatar').addEventListener('click', async () => {
  if (webRtcClient?.sessionId()) {
    if (recording || recordingBusy) { $('#conversation-message').textContent = 'Finish recording before disconnecting preview.'; return; }
    disconnectAvatar(); return;
  }
  if (!serviceReady || !currentProfile || projectionClient || projectionBusy || previewBusy) return;
  previewBusy = true;
  const attempt = ++connectionGeneration;
  showWebRtcState('connecting');
  let client;
  try {
    if (currentProfile.brain.mode === 'persona') {
      if (!currentProfile.brain.conversationId) await newConversation({ keepConnectionAttempt: true });
      else await loadHistory(currentProfile.brain.conversationId);
    }
    if (attempt !== connectionGeneration || !serviceReady) return;
    client = createWebRtcClient({
      RTCPeerConnection: testFixture ? FixturePeer : window.RTCPeerConnection,
      fetch: window.fetch.bind(window),
      baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
      onState: showWebRtcState,
      onTrack: receiveTrack,
    });
    webRtcClient = client;
    await client.connect({
      avatarId: currentProfile.liveTalking.avatarId,
      referenceWav: currentProfile.speech.referenceWav,
      referenceText: currentProfile.speech.referenceText,
      conversationId: currentProfile.brain.mode === 'persona' ? currentProfile.brain.conversationId : '',
    });
    if (attempt !== connectionGeneration || client !== webRtcClient) return;
    selectConversationTarget('preview');
  } catch (error) {
    if (attempt === connectionGeneration) $('#webrtc-state').textContent = `WebRTC: ${error.message}`;
  } finally {
    if (attempt === connectionGeneration) {
      if (client && !client.sessionId() && webRtcClient === client) webRtcClient = null;
      previewBusy = false;
      showWebRtcState(webRtcClient?.sessionId() ? 'connected' : 'disconnected');
    }
  }
});
$('#connect-projection').addEventListener('click', async () => {
  if (projectionClient?.sessionId()) {
    if (recording || recordingBusy) { $('#conversation-message').textContent = 'Finish recording before disconnecting projection.'; return; }
    try { await disconnectProjection(); } catch (error) { $('#projection-state').textContent = error.message; }
    return;
  }
  if (!serviceReady || !currentProfile || projectionBusy || previewBusy || webRtcClient) return;
  const url = $('#projection-url').value.trim();
  const token = $('#projection-token').value.trim();
  if (!url) { $('#projection-state').textContent = 'Enter the WHIP URL from Head in Jar'; return; }
  if ($('#projection-discovered').selectedOptions[0]?.dataset.auth === 'bearer' && !token) {
    $('#projection-state').textContent = 'This Head in Jar requires a bearer token'; return;
  }
  projectionBusy = true;
  const attempt = ++connectionGeneration;
  showProjectionState('connecting');
  let client;
  let failure = '';
  try {
    if (currentProfile.brain.mode === 'persona') {
      if (!currentProfile.brain.conversationId) await newConversation({ keepConnectionAttempt: true });
      else await loadHistory(currentProfile.brain.conversationId);
    }
    if (attempt !== connectionGeneration || !serviceReady) return;
    client = createProjectionClient({
      send: (action, input) => bridge.projectionRequest(currentProfile.id, action, input),
      onState: showProjectionState,
    });
    projectionClient = client;
    await client.connect({ url, token, avatarId: currentProfile.liveTalking.avatarId,
      referenceWav: currentProfile.speech.referenceWav, referenceText: currentProfile.speech.referenceText,
      conversationId: currentProfile.brain.mode === 'persona' ? currentProfile.brain.conversationId : '' });
    if (attempt !== connectionGeneration || client !== projectionClient) return;
    selectConversationTarget('projection');
    showProjectionState('connected');
  } catch (error) { if (attempt === connectionGeneration) failure = `Error: ${error.message}`; }
  finally {
    if (attempt === connectionGeneration) {
      if (client && !client.sessionId() && projectionClient === client) projectionClient = null;
      projectionBusy = false;
      $('#projection-token').value = '';
      showProjectionState(projectionClient?.sessionId() ? 'connected' : 'disconnected');
      if (failure) $('#projection-state').textContent = failure;
    }
  }
});
$('#message-text').addEventListener('input', updateConversationControls);
$('#microphone-button').addEventListener('click', async () => {
  if (conversationChangeBusy) return;
  const token = microphoneState === 'capturing' ? microphoneGeneration : ++microphoneGeneration;
  try {
    if (continuousVoiceClient) return;
    if (microphoneState === 'capturing') { await asrClient.stop(); return; }
    if (!serviceReady || !currentProfile) return;
    if (conversationClient && activeSessionId()) await conversationClient.interrupt();
    if (token !== microphoneGeneration) return;
    asrClient?.dispose();
    asrClient = createAsrClient({
      getUserMedia: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
      AudioContext: window.AudioContext,
      AudioWorkletNode: window.AudioWorkletNode,
      WebSocket: window.WebSocket,
      baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
      onState: (state, detail) => { if (token === microphoneGeneration) showMicrophoneState(state, detail); },
      onText: text => {
        if (token !== microphoneGeneration) return;
        $('#message-text').value = text;
        $('#conversation-message').textContent = 'Review the transcript and press Send.';
        updateConversationControls();
      },
    });
    await asrClient.start();
  } catch (error) { if (token === microphoneGeneration) showMicrophoneState('failed', error.message); }
});
$('#handsfree-button').addEventListener('click', async () => {
  if (conversationChangeBusy) return;
  if (continuousVoiceClient) {
    const restart = $('#handsfree-state').dataset.state === 'failed';
    await stopContinuousVoice();
    if (!restart) return;
  }
  if (!serviceReady || !activeSessionId() || !conversationClient) return;
  asrClient?.dispose(); asrClient = null;
  showMicrophoneState('idle');
  const targetSession = activeSessionId();
  const targetClient = conversationClient;
  let client;
  client = createContinuousVoiceClient({
    getUserMedia: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    AudioContext: window.AudioContext, AudioWorkletNode: window.AudioWorkletNode,
    WebSocket: window.WebSocket,
    baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
    allowBargeIn: $('#handsfree-barge-in').checked,
    onState: (state, detail) => { if (continuousVoiceClient === client) showContinuousVoiceState(state, detail); },
    onLevel: level => {
      if (continuousVoiceClient === client) $('#handsfree-level').textContent = `Input: ${(level * 100).toFixed(1)}%`;
    },
    onBargeIn: async () => {
      if (activeSessionId() !== targetSession) return;
      await targetClient.interrupt();
      speechInterrupted = true;
    },
    onTurn: async (text, { signal }) => {
      if (signal.aborted || activeSessionId() !== targetSession || continuousVoiceClient !== client) return;
      const canSend = await waitForSendSlot({ busy: () => sending, signal });
      if (!canSend) {
        if (!signal.aborted) throw new Error('The previous message is still being sent');
        return;
      }
      if (signal.aborted || activeSessionId() !== targetSession || continuousVoiceClient !== client) return;
      $('#message-text').value = text;
      updateConversationControls();
      const accepted = await submitTurn({ text, type: 'chat', requestId: crypto.randomUUID() });
      if (!accepted || signal.aborted || activeSessionId() !== targetSession) return;
      await waitForAvatarReply({ speaking: () => targetClient.speaking(),
        pending: () => currentProfile.brain.mode === 'persona' && brainState.pending > 0, signal });
    },
  });
  continuousVoiceClient = client;
  showContinuousVoiceState('starting');
  try { await client.start(); }
  catch (error) { if (continuousVoiceClient === client) showContinuousVoiceState('failed', error.message); }
});
async function submitTurn(turn) {
  if (!conversationClient || sending || conversationChangeBusy) return false;
  const { text, type, requestId } = turn;
  const submittedDraft = $('#message-text').value;
  const token = sessionGeneration;
  sending = true;
  updateConversationControls();
  submittedTurns.set(requestId, turn);
  if (![...$('#conversation-list').children].some(row => row.dataset.role === 'user' && row.dataset.requestId === requestId)) appendMessage(text, type, { requestId });
  try {
    speechInterrupted = type === 'echo' && brainState.pending > 0;
    await conversationClient.sendText(text, { type, interrupt: true, requestId });
    if (token !== sessionGeneration) return;
    failedTurn = null; $('#retry-message').hidden = true;
    if (submittedDraft.trim() === text && $('#message-text').value === submittedDraft) $('#message-text').value = '';
    $('#conversation-message').textContent = 'Message received.';
    return true;
  } catch (error) { if (token !== sessionGeneration) return false; $('#conversation-message').textContent = error.message; failedTurn = turn; $('#retry-message').hidden = false; return false; }
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
    if (brainState.pending) $('#brain-turn-state').textContent = 'Speech stopped; Persona is saving the response…';
    $('#conversation-message').textContent = 'Speech interrupted.';
  } catch (error) { $('#conversation-message').textContent = error.message; }
});
$('#record-avatar').addEventListener('click', async () => {
  if (recordingBusy || conversationChangeBusy) return;
  recordingBusy = true;
  updateConversationControls();
  try {
    if (!recording) {
      await conversationClient.startRecording();
      recording = true;
      $('#conversation-message').textContent = 'Recording…';
    } else {
      const sessionId = activeSessionId();
      await conversationClient.stopRecording();
      recording = false;
      updateConversationControls();
      const saved = await bridge.saveRecording(sessionId);
      $('#conversation-message').textContent = saved ? `Saved: ${saved}` : 'Recording stopped. Save cancelled.';
    }
  } catch (error) { $('#conversation-message').textContent = error.message; }
  finally { recordingBusy = false; updateConversationControls(); }
});
let speakingPollBusy = false;
const speakingTimer = setInterval(async () => {
  if (!conversationClient || !activeSessionId() || speakingPollBusy) return;
  const token = sessionGeneration;
  speakingPollBusy = true;
  try {
    const speaking = await conversationClient.speaking();
    if (token === sessionGeneration) $('#speaking-state').textContent = speaking ? 'Speaking' : 'Listening';
  }
  catch { if (token === sessionGeneration) $('#speaking-state').textContent = 'Status unavailable'; }
  finally { speakingPollBusy = false; }
}, 1000);
window.addEventListener('beforeunload', () => { clearInterval(speakingTimer); asrClient?.dispose(); void stopContinuousVoice(); });
const discoveryTimer = setInterval(() => { void refreshHeadinjarDiscovery(); }, 15000);
window.addEventListener('beforeunload', () => clearInterval(discoveryTimer));
const projectionTimer = setInterval(async () => {
  const client = projectionClient;
  if (!client?.sessionId()) return;
  try {
    const status = await client.status();
    if (client !== projectionClient) return;
    if (status.state !== 'connected') await disconnectProjection();
  }
  catch {
    if (client !== projectionClient) return;
    void disconnectProjection().catch(() => {});
    showProjectionState('failed');
  }
}, 2000);
window.addEventListener('beforeunload', () => { clearInterval(projectionTimer); void disconnectProjection(); });
window.addEventListener('beforeunload', disconnectAvatar);
const startupTimer = setInterval(() => {
  if (latestRuntimeSnapshot && ['checking', 'starting'].includes(latestRuntimeSnapshot.service.phase)) renderStartupProgress(latestRuntimeSnapshot);
}, 1000);
window.addEventListener('beforeunload', () => clearInterval(startupTimer));

if (bridge) {
  avatarUI = mountAvatarLibrary({ document, bridge, getProfile: () => currentProfile ? formProfile() : null,
    getSessionState: () => ({ serviceActive: ['checking', 'starting', 'ready', 'reconnecting', 'failed'].includes(servicePhase), servicePhase, recording, recordingBusy }),
    prepareSessionChange: async () => {
      if (recording || recordingBusy) throw new Error('Finish recording before changing or creating an avatar.');
      ++historyGeneration;
      asrClient?.dispose(); asrClient = null;
      await disconnectProjection();
      disconnectAvatar();
    },
    onProfileSelected: profile => { showProfile(profile); void checkSetup(); },
  });
  window.addEventListener('beforeunload', () => avatarUI.dispose());
  bridge.onSnapshot(showSnapshot);
  bridge.getSnapshot().then(showSnapshot).catch(error => message(error.message));
  bridge.getSetup().then(async ({ profile, voiceReferences, avatars, secrets, recoveryError, testFixture: fixture }) => {
    testFixture = fixture;
    showProfile(profile);
    avatarUI.applySnapshot(avatars || {});
    showKnownVoices(voiceReferences);
    showSecretStatus(secrets);
    if (recoveryError) { $('#setup-recovery').textContent = recoveryError; $('#setup-recovery').hidden = false; }
    await checkSetup();
    if (serviceReady && currentProfile.brain.mode === 'persona') await refreshConversations();
  }).catch(error => message(error.message));
}
