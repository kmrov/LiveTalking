import { createWebRtcClient } from './webrtc-client.mjs';
import { createProjectionClient } from './projection-client.mjs';
import { createConversationClient } from './conversation-client.mjs';
import { createAsrClient } from './asr-client.mjs';
import { createContinuousVoiceClient } from './continuous-voice-client.mjs';
import { createListenAudioSender } from './listen-audio-client.mjs';
import { waitForAvatarReply, waitForSendSlot } from './auto-turn.mjs';
import { FixturePeer } from './fixture-peer.mjs';
import { reduceBrainEvent } from './brain-events.mjs';
import { mountAvatarLibrary } from './avatar-library.mjs';
import { mountPanelResizers } from './panel-resize.mjs';
import { mountStudioDialogs } from './studio-dialogs.mjs';
import { projectionPreference, validProjectionUrl } from './projection-preferences.mjs';
import { conversationLabel } from './conversation-label.mjs';
import { activeProfileDraft, activeSecretDraft } from './profile-draft.mjs';

const bridge = window.liveTalkingDesktop;
if (bridge?.version) document.querySelector('#app-version').textContent = `v0.1 · API ${bridge.version}`;

const $ = selector => document.querySelector(selector);
mountPanelResizers({
  workspace: $('.workspace'), leftPanel: $('.left-panel'), rightPanel: $('.right-panel'),
  leftHandle: $('#left-panel-resizer'), rightHandle: $('#right-panel-resizer'),
});
const fields = {
  python: $('#python-path'), model: $('#avatar-model'), avatarId: $('#avatar-id'), port: $('#server-port'),
  mode: $('#speech-mode'), ttsEngine: $('#tts-engine'), asrVllm: $('#asr-vllm'), ttsVllm: $('#tts-vllm'), omniPython: $('#omni-python'),
  asrUrl: $('#asr-url'), ttsUrl: $('#tts-url'), voice: $('#voice-wav'),
  transcript: $('#voice-text'), autoStart: $('#auto-start'),
  brainMode: $('#brain-mode'), brainManaged: $('#brain-service-mode'), brainUrl: $('#brain-url'),
  brainRoot: $('#brain-root'), brainPython: $('#brain-python'), brainDatabase: $('#brain-database-mode'),
  brainFolder: $('#brain-folder'), brainKey: $('#brain-key'), brainDatabaseUrl: $('#brain-database-url'),
  brainStRoot: $('#brain-st-root'), brainStUrl: $('#brain-st-url'),
};
const conversationBrain = mode => ['persona', 'sillytavern'].includes(mode);
const brainName = mode => mode === 'sillytavern' ? 'SillyTavern' : mode === 'persona' ? 'Persona' : 'LLM';
let sillyTavernCharacters = [];
const activeBrainName = () => currentProfile?.brain.mode === 'sillytavern'
  ? sillyTavernCharacters.find(item => item.avatar === currentProfile.brain.sillyTavernCharacter)?.name || 'SillyTavern'
  : brainName(currentProfile?.brain.mode);
let currentProfile;
let avatarUI;
let servicePhase = "not-configured";
let latestRuntimeSnapshot;
let sessionGeneration = 0;
let knownVoices = [];
let webRtcClient;
let projectionClient;
let projectionBusy = false;
let projectionFailure = '';
let discoveryPending = false;
let previewBusy = false;
let previewAutoStarted = false;
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
let profileRoot = '';
let profileSwitchBusy = false;
let settingsDraft;
let settingsSaving = false;
let setupCheckGeneration = 0;
const dialogs = mountStudioDialogs({ document,
  onSettingsOpen() {
    settingsDraft = { root: profileRoot, voices: knownVoices, message: $('#setup-message').textContent,
      reviewHidden: $('#review-setup').hidden,
      fields: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
        field.type === 'checkbox' ? field.checked : field.value])) };
    $('#settings-message').textContent = '';
  },
  onSettingsClose({ saved }) {
    if (!saved && settingsDraft) {
      const rootChanged = profileRoot !== settingsDraft.root;
      profileRoot = settingsDraft.root;
      showKnownVoices(settingsDraft.voices);
      for (const [key, value] of Object.entries(settingsDraft.fields)) {
        const field = fields[key];
        if (field.type === 'checkbox') field.checked = value;
        else field.value = value;
      }
      syncKnownVoice();
      $('#root-path').textContent = profileRoot || 'Not found beside the app';
      showMode(); showBrainMode();
      message(settingsDraft.message);
      $('#review-setup').hidden = settingsDraft.reviewHidden;
      if (rootChanged) void avatarUI?.refresh();
    }
    settingsDraft = null;
  },
});

function showProfileSummary() {
  $('#profile-voice-summary').textContent = `${currentProfile?.speech.ttsEngine === 'omnivoice' ? 'OmniVoice' : 'Qwen'} · ${currentProfile?.speech.referenceWav?.split('/').at(-1) || 'No voice selected'}`;
  $('#profile-voice-summary').title = currentProfile?.speech.referenceWav || '';
  $('#profile-brain-summary').textContent = currentProfile?.brain.mode === 'direct' ? 'Direct LLM' : brainName(currentProfile?.brain.mode);
}

function showProfileList(profiles) {
  const select = $('#profile-picker');
  select.replaceChildren();
  const entries = [...profiles];
  if (currentProfile && !entries.some(profile => profile.id === currentProfile.id))
    entries.unshift({ id: currentProfile.id, name: currentProfile.name, brainMode: currentProfile.brain.mode });
  for (const profile of entries) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${brainName(profile.brainMode)}`;
    select.append(option);
  }
  select.value = currentProfile?.id || '';
}

function updateProfilePicker() {
  $('#profile-picker').disabled = profileSwitchBusy || servicePhase !== 'not-configured' || recording || recordingBusy;
  $('#profile-picker').title = servicePhase === 'not-configured' ? 'Choose a saved Studio profile' : 'Stop services before switching profiles';
}

function showProjectionTarget() {
  const selected = $('#projection-discovered').selectedOptions[0];
  $('#projection-target-label').textContent = selected?.value ? selected.textContent
    : $('#projection-url').value.trim() || 'No device selected';
}
$('#projection-settings-dialog').addEventListener('close', showProjectionTarget);

function saveProjectionAddress() {
  if (currentProfile) projectionPreference(localStorage, currentProfile.id, $('#projection-url').value);
}

function projectionError(text) {
  projectionFailure = text;
  $('#projection-state').textContent = text;
  const dialogMessage = $('#projection-dialog-message');
  if (dialogMessage) dialogMessage.textContent = text;
}

function activeSessionId() {
  return activeTarget === 'projection' ? projectionClient?.sessionId() : activeTarget === 'preview' ? webRtcClient?.sessionId() : null;
}

function listenSenderFor(sessionId) {
  if (!sessionId || currentProfile?.liveTalking.model !== 'avtr1') return null;
  return createListenAudioSender({ fetch: window.fetch.bind(window),
    baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`, sessionId });
}

function selectConversationTarget(target) {
  if (activeTarget !== target && continuousVoiceClient) void stopContinuousVoice();
  ++sessionGeneration;
  brainSource?.close(); brainSource = null;
  $('#brain-turn-state').dataset.stream = 'closed';
  activeTarget = target;
  const sessionId = activeSessionId();
  conversationClient = sessionId ? createConversationClient({
    fetch: window.fetch.bind(window), idempotentChat: conversationBrain(currentProfile.brain.mode),
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
  const labels = { idle: '', starting: 'Opening microphone and ASR…', listening: 'Listening: speak freely',
    capturing: 'Phrase detected; sending after a pause', transcribing: 'Transcribing phrase…', waiting: 'Waiting for avatar response', failed: 'Auto conversation error' };
  $('#handsfree-state').dataset.state = state;
  $('#handsfree-state').textContent = detail || labels[state] || '';
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
  $('#handsfree-transcript').hidden = true;
  $('#handsfree-transcript').textContent = '';
  showContinuousVoiceState('idle');
}

function updateConversationControls() {
  const active = Boolean(activeSessionId());
  $('#handsfree-button').disabled = conversationChangeBusy || (!continuousVoiceClient && (!serviceReady || !active));
  $('#send-message').disabled = conversationChangeBusy || !active || sending || !$('#message-text').value.trim();
  $('#interrupt-avatar').disabled = !active;
  $('#record-avatar').disabled = !active || recordingBusy || conversationChangeBusy;
  if (!active) { recording = false; $('#speaking-state').textContent = 'Disconnected'; }
  else if ($('#speaking-state').textContent === 'Disconnected' || $('#speaking-state').textContent === 'Idle') $('#speaking-state').textContent = 'Ready';
  const empty = $('.conversation-empty p');
  if (empty) empty.textContent = active ? 'Send a message or use the microphone to begin.' : 'Connect an avatar to start a conversation.';
  $('#record-avatar').textContent = recording ? 'Finish recording' : 'Record MP4';
  $('#connect-projection').disabled = !serviceReady || projectionBusy || previewBusy || recording || recordingBusy;
  const dialogConnect = $('#projection-connect-settings');
  if (dialogConnect) dialogConnect.disabled = $('#connect-projection').disabled;
  updateProjectionHint();
  if (latestRuntimeSnapshot) updateSpeechStopButtons(latestRuntimeSnapshot);
  avatarUI?.applySnapshot();
}

function updatePreviewControl() {
  const button = $('#connect-avatar');
  const connected = Boolean(webRtcClient?.sessionId());
  button.hidden = !serviceReady || previewBusy || projectionBusy || Boolean(projectionClient?.sessionId())
    || (!connected && !previewAutoStarted);
  button.disabled = !serviceReady || previewBusy || projectionBusy || Boolean(projectionClient?.sessionId());
  button.textContent = connected ? 'Disconnect preview' : 'Enable preview';
}

function appendMessage(text, type, { role = 'user', requestId = '' } = {}) {
  $('.conversation-empty').hidden = true;
  $('#conversation-list').hidden = false;
  const row = document.createElement('li');
  row.dataset.role = role;
  row.dataset.requestId = requestId;
  const label = document.createElement('small');
  label.textContent = role === 'assistant' ? activeBrainName().toUpperCase() : type === 'echo' ? 'YOU · SPEAK' : 'YOU · CHAT';
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
  updatePreviewControl();
  $('#connect-projection').disabled = !serviceReady || previewBusy || projectionBusy || recording || recordingBusy;
  $('#connect-projection').textContent = projectionClient?.sessionId() ? 'Disconnect projection'
    : webRtcClient?.sessionId() ? 'Switch to Head in Jar' : 'Connect projection';
  updateProjectionHint();
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
  if (state !== 'disconnected') projectionFailure = '';
  $('#projection-state').textContent = state === 'disconnected' && projectionFailure ? projectionFailure : labels[state] || state;
  $('#projection-state').dataset.sessionId = projectionClient?.sessionId() || '';
  $('#connect-projection').textContent = projectionClient?.sessionId() ? 'Disconnect projection' : webRtcClient?.sessionId() ? 'Switch to Head in Jar' : 'Connect projection';
  $('#connect-projection').disabled = !serviceReady || projectionBusy || previewBusy || recording || recordingBusy;
  updatePreviewControl();
  const dialogConnect = $('#projection-connect-settings');
  if (dialogConnect) dialogConnect.disabled = !serviceReady || projectionBusy || previewBusy || recording || recordingBusy;
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
    const selected = $('#projection-url').value.trim();
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
  if (url) { $('#projection-url').value = url; $('#projection-token').value = ''; saveProjectionAddress(); }
  updateProjectionHint();
  $('#projection-dialog-message').textContent = '';
});
$('#projection-url').addEventListener('input', () => {
  if ($('#projection-url').value !== $('#projection-discovered').value) $('#projection-discovered').value = '';
  saveProjectionAddress();
  updateProjectionHint();
  $('#projection-dialog-message').textContent = '';
});

function updateProjectionHint() {
  showProjectionTarget();
  const selected = $('#projection-discovered').selectedOptions[0];
  let hint = $('#projection-discovered').value
    ? selected?.dataset.auth === 'bearer'
      ? 'This device requires a token. Add it in Connection settings.'
      : 'Discovered Head in Jar: connect without a token. Enable the projector there separately.'
    : validProjectionUrl($('#projection-url').value) ? 'Ready to connect to the saved Head in Jar address.'
      : 'Choose a device or enter its WHIP URL in Connection settings.';
  if (!serviceReady) hint = servicePhase === 'failed' ? 'Profile did not start: check the startup log.'
    : servicePhase === 'starting' || servicePhase === 'checking' ? 'Wait for services to start; connection becomes available when they are Running.'
      : 'Start the Studio profile first.';
  else if (recording || recordingBusy) hint = 'Finish recording before switching the stream.';
  else if (webRtcClient?.sessionId()) hint = 'Switch to Head in Jar will close the preview and connect projection.';
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
  if (mode) mode.textContent = currentProfile?.brain.mode === 'persona' ? 'Persona mode'
    : currentProfile?.brain.mode === 'sillytavern' ? 'SillyTavern mode' : 'Direct LLM';
  if (setup) setup.textContent = activeSessionId()
    ? 'Services are running. Control speech and recording in the conversation panel.'
    : serviceReady && previewBusy ? 'Services are running. Connecting the avatar preview…'
    : serviceReady ? 'Services are running. Reconnect the preview here or connect Head in Jar for projection.'
    : 'Check your environment and profile, then start services.';
  if (emptyTitle && emptyDetail) {
    emptyTitle.textContent = projectionClient?.sessionId() ? 'Streaming to Head in Jar'
      : webRtcClient?.sessionId() ? 'Waiting for avatar video'
        : previewBusy ? 'Connecting to avatar' : serviceReady ? 'Preview disconnected'
          : ['checking', 'starting'].includes(servicePhase) ? 'Starting your avatar' : 'Your avatar will appear here';
    emptyDetail.textContent = projectionClient?.sessionId()
      ? 'Video is in Head in Jar. Use the Conversation panel here to speak or send text.'
      : webRtcClient?.sessionId() ? 'The video stream is still loading.'
        : previewBusy ? 'Opening the video stream automatically.' : serviceReady ? ''
          : ['checking', 'starting'].includes(servicePhase) ? 'The preview will connect automatically when services are ready.'
            : 'Start a profile to see your avatar.';
  }
  if (!hint) return;
  hint.textContent = activeSessionId() ? 'Connected · speak or send text.'
    : ['checking', 'starting'].includes(servicePhase) ? 'Services are starting · wait for loading to finish.'
      : serviceReady && previewBusy ? 'Connecting preview…'
      : serviceReady ? 'Ready · reconnect preview or connect projection.'
        : servicePhase === 'failed' ? 'Startup failed · check the log and profile.'
          : 'First step · configure the profile and start services.';
}

async function disconnectProjection() {
  ++connectionGeneration;
  projectionBusy = false;
  projectionFailure = '';
  if (activeTarget === 'projection') selectConversationTarget('none');
  const client = projectionClient;
  projectionClient = null;
  showProjectionState('disconnected');
  if (client) await client.disconnect();
}
const phaseLabels = {
  'not-configured': 'Stopped', checking: 'Checking', starting: 'Starting',
  ready: 'Running', reconnecting: 'Reconnecting', failed: 'Error',
};
const stageLabels = { stopped: 'Idle', waiting: 'Queued', ready: 'Running', failed: 'Error' };
const stageNames = { database: 'PostgreSQL', persona: 'Persona', sillytavern: 'SillyTavern', bridge: 'Studio bridge', asr: 'Qwen ASR', tts: 'Qwen TTS', livetalking: 'LiveTalking' };
function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function updateSpeechStopButtons(snapshot) {
  const phase = snapshot.service.phase;
  for (const stage of ['asr', 'tts']) {
    const owned = snapshot.ownedSpeechModels?.some(model => model.stage === stage);
    const button = $(`#stop-${stage}`);
    button.hidden = !owned;
    button.disabled = !owned || ['checking', 'starting'].includes(phase) || (snapshot.supervisor?.adopted && phase === 'ready') || recording || recordingBusy;
    if (owned && snapshot.supervisor?.stages?.[stage] !== 'starting' && phase !== 'ready') {
      const label = $(`#${stage}-state`);
      const failed = snapshot.supervisor?.stages?.[stage] === 'failed';
      label.dataset.state = failed ? 'failed' : 'waiting';
      label.textContent = failed ? 'Process remains' : 'Process running';
    }
  }
}
function renderStartupProgress(snapshot) {
  const phase = snapshot.service.phase;
  const active = [];
  for (const stage of ['database', 'persona', 'sillytavern', 'bridge', 'asr', 'tts', 'livetalking']) {
    const owner = ['database', 'persona', 'sillytavern', 'bridge'].includes(stage) ? snapshot.brain : snapshot.supervisor;
    const state = owner?.stages?.[stage] || 'stopped';
    const startedAt = owner?.stageStartedAt?.[stage];
    const label = $(`#${stage}-state`);
    label.dataset.state = state;
    label.textContent = state === 'starting'
      ? `${stage === 'asr' || stage === 'tts' ? 'Loading model' : 'Starting'}${startedAt ? ` · ${formatElapsed(startedAt)}` : ''}`
      : stageLabels[state] || state;
    if (state === 'starting') active.push(stage === 'tts' && currentProfile?.speech.ttsEngine === 'omnivoice' ? 'OmniVoice TTS' : stageNames[stage]);
  }
  updateSpeechStopButtons(snapshot);
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
  if (!serviceReady) previewAutoStarted = false;
  $('.setup-card').classList.toggle('is-running', serviceReady);
  if (serviceReady && !wasReady) void refreshHeadinjarDiscovery();
  $('#setup-title').textContent = serviceReady ? 'Profile running' : phase === 'failed' ? 'Startup failed' : 'Profile stopped';
  if (serviceReady && !wasReady) $('#check-details').open = false;
  const serviceDetails = $('#service-details');
  if (serviceDetails && (['checking', 'starting', 'failed'].includes(phase) || (wasReady && !serviceReady))) serviceDetails.open = true;
  if (serviceDetails && serviceReady && !wasReady) serviceDetails.open = false;
  showWebRtcState(webRtcState);
  showProjectionState(projectionClient?.sessionId() ? 'connected' : 'disconnected');
  if (!serviceReady && (webRtcClient || previewBusy)) disconnectAvatar();
  if (!serviceReady && (projectionClient || projectionBusy)) void disconnectProjection().catch(error => { projectionError(error.message); });
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
  updateProfilePicker();
  renderStartupProgress(snapshot);
  $('#runtime-log').textContent = [snapshot.brain?.logExcerpt, snapshot.supervisor?.logExcerpt, snapshot.service.detail].filter(Boolean).join('\n') || 'No messages';
  if (serviceReady && !wasReady && conversationBrain(currentProfile?.brain.mode)) void refreshConversations().catch(error => { $('#conversation-message').textContent = error.message; });
  if (serviceReady && !wasReady && currentProfile?.brain.mode === 'sillytavern') void refreshSillyTavernCharacters();
  avatarUI?.applySnapshot();
  if (phase === 'failed') message(snapshot.service.detail || 'Service failed');
  if (serviceReady && !wasReady && $('#setup-message').textContent === 'Starting services…') message('');
  updateWorkflowHint();
  if (serviceReady) maybeAutoConnectPreview();
}

function showKnownVoices(voices) {
  knownVoices = voices;
  const select = $('#known-voices');
  select.replaceChildren();
  const blank = new Option('Choose a sample', '');
  blank.dataset.placeholder = 'true';
  select.append(blank);
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.wav;
    option.textContent = voice.wav.split('/').at(-1);
    select.append(option);
  }
  syncKnownVoice();
}

function syncKnownVoice() {
  const select = $('#known-voices');
  const wav = fields.voice.value.trim();
  if (!select.querySelector('option[data-placeholder]')) {
    const blank = new Option('Choose a sample', '');
    blank.dataset.placeholder = 'true';
    select.prepend(blank);
  }
  select.querySelector('option[data-custom]')?.remove();
  if (wav && !knownVoices.some(voice => voice.wav === wav)) {
    const option = new Option(`Custom file · ${wav.split('/').at(-1)}`, wav);
    option.dataset.custom = 'true';
    select.append(option);
    $('#voice-sample-details').open = true;
  }
  $('#known-voices-label').hidden = select.options.length === 1;
  select.value = wav;
  const preview = $('#voice-preview');
  if (preview) preview.disabled = !wav;
  const audio = $('#voice-preview-audio');
  if (audio && audio.dataset.wav !== wav) {
    audio.pause(); audio.removeAttribute('src'); audio.dataset.wav = '';
    if (preview) preview.textContent = 'Play sample';
  }
}

function showMode() {
  const external = fields.mode.value === 'external';
  const omni = fields.ttsEngine.value === 'omnivoice';
  $('#local-model-fields').hidden = external;
  $('#external-model-fields').hidden = !external;
  fields.asrUrl.disabled = !external;
  fields.ttsUrl.disabled = !external;
  fields.ttsVllm.closest('label').hidden = external || omni;
  fields.omniPython.closest('label').hidden = external || !omni;
}

function showBrainMode() {
  const persona = fields.brainMode.value === 'persona';
  const sillytavern = fields.brainMode.value === 'sillytavern';
  $('#brain-settings').hidden = !persona && !sillytavern;
  $('#brain-persona-fields').hidden = !persona;
  $('#brain-st-fields').hidden = !sillytavern;
  fields.brainUrl.disabled = !persona;
  fields.brainStUrl.disabled = !sillytavern;
  $('#brain-managed-fields').hidden = !persona || fields.brainManaged.value !== 'managed';
  const advanced = $('#brain-advanced');
  advanced.hidden = !sillytavern && (!persona || fields.brainManaged.value !== 'managed');
  if (advanced.hidden) advanced.open = false;
  $('#brain-yandex-fields').hidden = !sillytavern && (!persona || fields.brainManaged.value !== 'managed');
  $('#brain-conversations').hidden = !persona && !sillytavern;
  $('#st-character-picker').hidden = !sillytavern;
  $('#brain-library').hidden = !persona;
  $('#open-memory').hidden = !persona;
  document.querySelectorAll('.persona-service').forEach(row => { row.hidden = !persona; });
  document.querySelectorAll('.sillytavern-service').forEach(row => { row.hidden = !sillytavern; });
  $('#brain-conversation-label').textContent = sillytavern ? 'SillyTavern conversation' : 'Persona conversation';
  $('#conversation-mode option[value="chat"]').textContent = persona ? 'Chat with Persona' : sillytavern ? 'Chat with SillyTavern' : 'Chat with LLM';
  updateCharacterControls();
}

function updateCharacterControls() {
  const enabled = currentProfile?.brain.mode === 'sillytavern' && fields.brainMode.value === 'sillytavern';
  $('#st-character').disabled = !enabled || conversationChangeBusy || !sillyTavernCharacters.length;
  $('#refresh-st-characters').disabled = !enabled || conversationChangeBusy;
}

function showSelectedCharacter() {
  const select = $('#st-character');
  const avatar = currentProfile?.brain.sillyTavernCharacter || 'Viktor_Petrovich_Studio.png';
  select.replaceChildren();
  for (const item of sillyTavernCharacters) {
    const option = document.createElement('option'); option.value = item.avatar; option.textContent = item.name;
    select.append(option);
  }
  if (!sillyTavernCharacters.some(item => item.avatar === avatar)) {
    const option = document.createElement('option'); option.value = avatar; option.textContent = `Selected: ${avatar}`;
    select.prepend(option);
  }
  select.value = avatar;
  updateCharacterControls();
}

function showSecretStatus(status) {
  $('#brain-secret-status').textContent = `${status.apiKeyConfigured ? 'API key configured.' : 'API key not configured.'} ${status.persistent ? 'Entered keys are saved in the system keyring.' : 'Entered keys are kept until the app closes; use a local .env for persistent settings.'}`;
}

function showProfile(profile) {
  currentProfile = profile;
  ++memoryGeneration;
  projectionFailure = '';
  $('#projection-url').value = projectionPreference(localStorage, profile.id);
  $('#projection-discovered').value = '';
  $('#projection-token').value = '';
  updateProjectionHint();
  profileRoot = profile.liveTalking.root;
  showProfileSummary();
  void refreshHeadinjarDiscovery();
  $('#profile-picker').value = profile.id;
  syncSavedForm(profile);
  syncKnownVoice();
  sillyTavernCharacters = [];
  showSelectedCharacter();
  brainState = { conversationId: profile.brain.conversationId, turns: {}, pending: 0 };
  $('#brain-turn-state').textContent = `${activeBrainName()} is idle`;
  showMode();
  showBrainMode();
  if (profile.brain.mode === 'sillytavern') void refreshSillyTavernCharacters();
  updateWorkflowHint();
  if (serviceReady) maybeAutoConnectPreview();
}

function formProfile() {
  return activeProfileDraft(currentProfile, {
    ...currentProfile,
    liveTalking: {
      ...currentProfile.liveTalking,
      root: profileRoot,
      python: fields.python.value,
      model: fields.model.value,
      avatarId: fields.avatarId.value,
      port: Number(fields.port.value),
    },
    speech: {
      ...currentProfile.speech,
      mode: fields.mode.value,
      ttsEngine: fields.ttsEngine.value,
      asrVllm: fields.asrVllm.value,
      ttsVllm: fields.ttsVllm.value,
      omniPython: fields.omniPython.value,
      asrUrl: fields.asrUrl.value,
      ttsUrl: fields.ttsUrl.value,
      referenceWav: fields.voice.value,
      referenceText: fields.transcript.value,
    },
    autoStart: fields.autoStart.checked,
    brain: { ...currentProfile.brain, mode: fields.brainMode.value,
      managed: fields.brainManaged.value === 'managed', url: fields.brainUrl.value,
      root: fields.brainRoot.value, python: fields.brainPython.value,
      databaseMode: fields.brainDatabase.value, folderId: fields.brainFolder.value,
      sillyTavernRoot: fields.brainStRoot.value, sillyTavernUrl: fields.brainStUrl.value,
      conversationId: fields.brainMode.value === currentProfile.brain.mode ? currentProfile.brain.conversationId : '' },
  });
}

function syncSavedForm(profile) {
  profileRoot = profile.liveTalking.root;
  $('#root-path').textContent = profileRoot || 'Not found beside the app';
  fields.python.value = profile.liveTalking.python;
  fields.model.value = profile.liveTalking.model;
  fields.avatarId.value = profile.liveTalking.avatarId;
  fields.port.value = profile.liveTalking.port;
  fields.mode.value = profile.speech.mode;
  fields.ttsEngine.value = profile.speech.ttsEngine;
  fields.asrVllm.value = profile.speech.asrVllm;
  fields.ttsVllm.value = profile.speech.ttsVllm;
  fields.omniPython.value = profile.speech.omniPython;
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
  fields.brainStRoot.value = profile.brain.sillyTavernRoot;
  fields.brainStUrl.value = profile.brain.sillyTavernUrl;
}

async function saveCurrentProfile() {
  const profile = formProfile();
  const needsStop = ['checking', 'starting', 'ready', 'reconnecting', 'failed'].includes(servicePhase)
    && ['root', 'python', 'model', 'avatarId', 'port'].some(key => currentProfile.liveTalking[key] !== profile.liveTalking[key]);
  if (needsStop) {
    if (recording || recordingBusy) throw new Error('Finish recording before applying avatar or environment changes.');
    message('Stopping services to apply profile changes…');
    await stopContinuousVoice();
    await disconnectProjection();
    disconnectAvatar();
  }
  currentProfile = await bridge.saveProfile(profile);
  syncSavedForm(currentProfile);
  showMode(); showBrainMode(); syncKnownVoice();
  showProfileList(await bridge.listProfiles());
  const status = await bridge.setBrainSecrets(currentProfile.id, activeSecretDraft(currentProfile, {
    apiKey: fields.brainKey.value, databaseUrl: fields.brainDatabaseUrl.value,
  }));
  fields.brainKey.value = ''; fields.brainDatabaseUrl.value = '';
  showSecretStatus(status);
  showProfileSummary();
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
  if (!currentProfile || !conversationBrain(currentProfile.brain.mode)) return;
  const profileId = currentProfile.id;
  const conversations = await bridge.brainConversations(profileId);
  if (currentProfile?.id !== profileId) return;
  const select = $('#brain-conversation');
  select.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'New conversation'; select.append(blank);
  for (const conversation of conversations) {
    const option = document.createElement('option'); option.value = conversation.id;
    option.textContent = conversationLabel(conversation);
    select.append(option);
  }
  select.value = currentProfile.brain.conversationId;
  await loadHistory(currentProfile.brain.conversationId);
  for (const conversation of conversations.slice(0, 20)) {
    if (conversation.title) continue;
    void bridge.brainHistory(profileId, conversation.id).then(messages => {
      if (currentProfile?.id !== profileId) return;
      const option = [...select.options].find(item => item.value === conversation.id);
      if (option && !option.dataset.hasMessage) {
        option.textContent = conversationLabel(conversation, messages);
        if (messages.some(item => item?.role === 'user' && item.text?.trim())) option.dataset.hasMessage = 'true';
      }
    }).catch(() => {});
  }
}

async function refreshSillyTavernCharacters() {
  if (currentProfile?.brain.mode !== 'sillytavern') return;
  const profileId = currentProfile.id;
  const label = $('#st-character-message');
  label.textContent = 'Loading characters…';
  try {
    const characters = await bridge.sillyTavernCharacters(profileId);
    if (currentProfile?.id !== profileId || currentProfile.brain.mode !== 'sillytavern') return;
    sillyTavernCharacters = characters;
    showSelectedCharacter();
    label.textContent = characters.length ? `${characters.length} characters available.` : 'No SillyTavern characters found.';
  } catch (error) {
    if (currentProfile?.id === profileId) label.textContent = serviceReady ? error.message : 'Start the profile or SillyTavern, then refresh characters.';
  }
}

function updateConversationSelectionControls() {
  $('#new-brain-conversation').disabled = conversationChangeBusy;
  $('#brain-conversation').disabled = conversationChangeBusy;
  $('#refresh-brain-conversations').disabled = conversationChangeBusy;
  updateCharacterControls();
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
  $('#brain-turn-state').textContent = `${activeBrainName()} is idle`;
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

async function switchSillyTavernCharacter(avatar) {
  if (currentProfile?.brain.mode !== 'sillytavern' || avatar === currentProfile.brain.sillyTavernCharacter) return;
  if (conversationChangeBusy || sending || previewBusy || projectionBusy) throw new Error('Wait for the current conversation action to finish.');
  if (recording || recordingBusy) throw new Error('Finish recording before changing characters.');
  const previous = structuredClone(currentProfile);
  conversationChangeBusy = true;
  updateConversationSelectionControls();
  try {
    if (continuousVoiceClient) await stopContinuousVoice();
    ++microphoneGeneration;
    asrClient?.dispose(); asrClient = null;
    showMicrophoneState('idle');
    currentProfile = await bridge.selectSillyTavernCharacter(previous.id, avatar);
    if (activeSessionId()) {
      const conversation = await bridge.createBrainConversation(previous.id);
      await applyBrainConversation(conversation.id);
    } else {
      clearConversation();
      if (serviceReady) await refreshConversations();
    }
    showSelectedCharacter();
    $('#brain-turn-state').textContent = `${activeBrainName()} is idle`;
    $('#conversation-message').textContent = '';
  } catch (error) {
    await bridge.selectSillyTavernCharacter(previous.id, previous.brain.sillyTavernCharacter).catch(() => {});
    await bridge.saveProfile(previous).catch(() => {});
    currentProfile = previous;
    if (activeSessionId() && previous.brain.conversationId) await conversationClient?.setConversation(previous.brain.conversationId).catch(() => {});
    showSelectedCharacter();
    throw error;
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
    const name = activeBrainName().toUpperCase();
    row.querySelector('small').textContent = turn.status === 'delta' ? `${name} · REPLYING` : turn.status === 'error' ? `${name} · ERROR` : name;
    row.scrollIntoView({ block: 'nearest' });
  }
  if (turn.status === 'error') { failedTurn = submittedTurns.get(event.request_id); $('#retry-message').hidden = !failedTurn; }
  if (!brainState.pending) speechInterrupted = false;
  const name = activeBrainName();
  $('#brain-turn-state').textContent = brainState.pending
    ? speechInterrupted ? `Speech stopped; ${name} is saving the response…` : event.event === 'delta' ? `${name} is replying…` : `${name} is thinking…`
    : `${name} is idle`;
}

function connectBrainEvents() {
  brainSource?.close();
  if (!conversationBrain(currentProfile.brain.mode)) return;
  brainSource = new EventSource(`http://127.0.0.1:${currentProfile.liveTalking.port}/sse?sessionid=${encodeURIComponent(activeSessionId())}`);
  const source = brainSource;
  const token = sessionGeneration;
  brainSource.onopen = () => { if (source !== brainSource || token !== sessionGeneration) return; $('#brain-turn-state').dataset.stream = 'connected'; };
  brainSource.onmessage = message => { if (source !== brainSource || token !== sessionGeneration) return; try { receiveBrainEvent(JSON.parse(message.data)); } catch { /* Other LiveTalking events can share this stream. */ } };
  brainSource.onerror = () => { if (source !== brainSource || token !== sessionGeneration) return; $('#brain-turn-state').textContent = 'Reconnecting response stream…'; };
}

function message(text) {
  $('#setup-message').textContent = text;
  $('#settings-message').textContent = text;
}

function showButtonProgress(selector, busy) {
  const button = $(selector);
  button.querySelector('.button-spinner').hidden = !busy;
  button.setAttribute('aria-busy', String(busy));
}

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

async function checkSetup(reveal = false) {
  const generation = ++setupCheckGeneration;
  showButtonProgress('#check-setup', true);
  $('#check-setup').disabled = true;
  $('#save-profile').disabled = true;
  message('Checking environment…');
  try {
    const results = await bridge.checkSetup(formProfile());
    if (generation !== setupCheckGeneration) return null;
    showResults(results);
    const missing = results.filter(item => item.state !== 'ready').length;
    const manual = results.filter(item => item.state !== 'ready' && !(item.state === 'missing' && ['avatar-model', 'asr-model', 'tts-model'].includes(item.id))).length;
    $('#check-details').open = reveal || missing > 0;
    if (manual) {
      $('#services-advanced').open = true;
      $('#brain-advanced').open = true;
    }
    $('#review-setup').hidden = !manual;
    message(manual ? `${manual} setup ${manual === 1 ? 'item needs' : 'items need'} attention.` : missing ? 'Models will be downloaded at startup.' : '');
    return results;
  } catch (error) { if (generation === setupCheckGeneration) message(error.message); return null; }
  finally {
    if (generation === setupCheckGeneration) {
      showButtonProgress('#check-setup', false);
      $('#check-setup').disabled = settingsSaving;
      $('#save-profile').disabled = settingsSaving;
    }
  }
}

fields.mode.addEventListener('change', showMode);
fields.ttsEngine.addEventListener('change', showMode);
fields.brainMode.addEventListener('change', showBrainMode);
fields.brainManaged.addEventListener('change', showBrainMode);
$('#choose-brain-root').addEventListener('click', async () => {
  const root = await bridge.chooseBrainRoot();
  if (root) { fields.brainRoot.value = root; fields.brainPython.value = `${root}/.venv/bin/python`; }
});
$('#new-brain-conversation').addEventListener('click', () => { void newConversation().catch(error => { $('#conversation-message').textContent = error.message; }); });
$('#refresh-brain-conversations').addEventListener('click', () => { void refreshConversations().catch(error => { $('#conversation-message').textContent = error.message; }); });
$('#refresh-st-characters').addEventListener('click', () => { void refreshSillyTavernCharacters(); });
$('#st-character').addEventListener('change', async () => {
  try { await switchSillyTavernCharacter($('#st-character').value); }
  catch (error) {
    showSelectedCharacter();
    $('#conversation-message').textContent = error.message;
  }
});
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
  await loadMemories();
});
let memoryGeneration = 0;
async function loadMemories() {
  const generation = ++memoryGeneration;
  const profileId = currentProfile?.id;
  if (!profileId || currentProfile.brain.mode !== 'persona') return;
  $('#brain-library-message').textContent = 'Loading memory…';
  try {
    const memories = await bridge.brainMemories(profileId);
    if (generation !== memoryGeneration || currentProfile?.id !== profileId || !$('#memory-dialog').open) return;
    $('#brain-memories').replaceChildren();
    for (const memory of memories) { const row = document.createElement('li'); row.textContent = memory.text; $('#brain-memories').append(row); }
    $('#brain-library-message').textContent = memories.length ? '' : 'Memory is empty.';
  } catch (error) { if (generation === memoryGeneration && currentProfile?.id === profileId && $('#memory-dialog').open) $('#brain-library-message').textContent = error.message; }
}
$('#open-memory').addEventListener('click', () => { void loadMemories(); });
$('#memory-dialog').addEventListener('close', () => { ++memoryGeneration; });
$('#brain-document-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await bridge.brainDocument(currentProfile.id, { title: $('#brain-document-title').value, source: $('#brain-document-source').value, content: $('#brain-document-content').value });
    $('#brain-library-message').textContent = 'Document added to Persona.';
    $('#brain-document-content').value = '';
  } catch (error) { $('#brain-library-message').textContent = error.message; }
});
$('#known-voices').addEventListener('change', () => {
  if (!$('#known-voices').value) {
    fields.voice.value = '';
    fields.transcript.value = '';
    syncKnownVoice();
    return;
  }
  const voice = knownVoices.find(item => item.wav === $('#known-voices').value);
  if (voice) {
    fields.voice.value = voice.wav;
    fields.transcript.value = voice.text;
  }
  syncKnownVoice();
});
fields.voice.addEventListener('input', syncKnownVoice);
$('#voice-preview')?.addEventListener('click', async () => {
  const wav = fields.voice.value.trim();
  if (!wav) return;
  const audio = $('#voice-preview-audio');
  const button = $('#voice-preview');
  if (!audio.paused) { audio.pause(); button.textContent = 'Play sample'; return; }
  try {
    button.disabled = true;
    if (audio.dataset.wav !== wav) {
      const source = await bridge.previewVoiceWav(currentProfile.id, wav);
      if (!$('#profile-settings-dialog').open || fields.voice.value.trim() !== wav) return;
      audio.src = source;
      audio.dataset.wav = wav;
    }
    audio.currentTime = 0;
    await audio.play();
    button.textContent = 'Stop sample';
  } catch (error) { if ($('#profile-settings-dialog').open) $('#settings-message').textContent = error.message; }
  finally { button.disabled = !fields.voice.value.trim(); }
});
$('#voice-preview-audio')?.addEventListener('ended', () => { $('#voice-preview').textContent = 'Play sample'; });
$('#profile-settings-dialog').addEventListener('close', () => {
  const audio = $('#voice-preview-audio');
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.dataset.wav = ''; }
  const button = $('#voice-preview');
  if (button) button.textContent = 'Play sample';
});
$('#check-setup').addEventListener('click', () => { dialogs.selectTab('services'); void checkSetup(true); });
$('#setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (settingsSaving) return;
  settingsSaving = true;
  dialogs.setBusy(true);
  showButtonProgress('#save-profile', true);
  message('Saving profile…');
  try {
    await saveCurrentProfile();
    await checkSetup();
    message(serviceReady ? 'Restart services to apply changes.' : '');
    dialogs.closeSettings();
  } catch (error) { message(error.message); }
  finally { settingsSaving = false; dialogs.setBusy(false); showButtonProgress('#save-profile', false); }
});
$('#choose-root').addEventListener('click', async () => {
  const selected = await bridge.chooseLiveTalkingRoot();
  if (!selected) return;
  const { root, voiceReferences } = selected;
  const previous = profileRoot;
  profileRoot = root;
  if (!fields.python.value || fields.python.value === `${previous}/.venv/bin/python`) fields.python.value = `${root}/.venv/bin/python`;
  $('#root-path').textContent = root;
  showKnownVoices(voiceReferences);
  if (voiceReferences.length) {
    fields.voice.value = voiceReferences[0].wav;
    fields.transcript.value = voiceReferences[0].text;
    syncKnownVoice();
  }
  await avatarUI?.refresh();
  await checkSetup();
});
$('#choose-voice').addEventListener('click', async () => {
  const file = await bridge.chooseVoiceWav();
  if (file) {
    fields.voice.value = file;
    syncKnownVoice();
  }
});

$('#start-profile').addEventListener('click', async () => {
  showButtonProgress('#start-profile', true);
  $('#start-profile').disabled = true;
  try {
    await saveCurrentProfile();
    const results = await checkSetup();
    if (!results) return;
    message('Starting services…');
    await bridge.startProfile(currentProfile.id);
  } catch (error) { message(error.message); }
  finally {
    showButtonProgress('#start-profile', false);
    $('#start-profile').disabled = ['checking', 'starting', 'ready'].includes(servicePhase);
  }
});
$('#profile-picker').addEventListener('change', async () => {
  const id = $('#profile-picker').value;
  const previous = currentProfile?.id;
  if (!id || id === previous) return;
  if (servicePhase !== 'not-configured' || recording || recordingBusy) { $('#profile-picker').value = previous; return; }
  profileSwitchBusy = true;
  updateProfilePicker();
  try {
    const { profile, voiceReferences, avatars, secrets } = await bridge.getProfile(id);
    ++historyGeneration;
    clearConversation();
    $('#brain-conversation').replaceChildren(new Option('New conversation', ''));
    showProfile(profile);
    showKnownVoices(voiceReferences);
    showSecretStatus(secrets);
    avatarUI?.applySnapshot(avatars || {});
    await checkSetup();
  } catch (error) {
    $('#profile-picker').value = previous;
    message(error.message);
  } finally {
    profileSwitchBusy = false;
    updateProfilePicker();
  }
});
$('#stop-profile').addEventListener('click', async () => {
  if (recording || recordingBusy) { $('#conversation-message').textContent = 'Finish recording before stopping the profile.'; return; }
  try { await disconnectProjection(); } catch (error) { $('#projection-state').textContent = error.message; }
  try { await bridge.stopProfile(); } catch (error) { message(error.message); }
});
for (const stage of ['asr', 'tts']) $(`#stop-${stage}`).addEventListener('click', async () => {
  if (recording || recordingBusy) { $('#conversation-message').textContent = 'Finish recording before stopping a speech server.'; return; }
  try { await bridge.stopSpeechModel(stage); }
  catch (error) { message(error.message); }
});
async function connectAvatar() {
  if (!serviceReady || !currentProfile || projectionClient || projectionBusy || previewBusy) return;
  previewBusy = true;
  const attempt = ++connectionGeneration;
  showWebRtcState('connecting');
  let client;
  let failure = '';
  try {
    if (conversationBrain(currentProfile.brain.mode)) {
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
      conversationId: conversationBrain(currentProfile.brain.mode) ? currentProfile.brain.conversationId : '',
    });
    if (attempt !== connectionGeneration || client !== webRtcClient) return;
    selectConversationTarget('preview');
  } catch (error) {
    if (attempt === connectionGeneration) failure = `WebRTC: ${error.message}`;
  } finally {
    if (attempt === connectionGeneration) {
      if (client && !client.sessionId() && webRtcClient === client) webRtcClient = null;
      previewBusy = false;
      showWebRtcState(webRtcClient?.sessionId() ? 'connected' : 'disconnected');
      if (failure) $('#webrtc-state').textContent = failure;
    }
  }
}

function maybeAutoConnectPreview() {
  if (!serviceReady || !currentProfile || previewAutoStarted || webRtcClient || projectionClient || projectionBusy) return;
  previewAutoStarted = true;
  void connectAvatar();
}

$('#connect-avatar').addEventListener('click', async () => {
  if (webRtcClient?.sessionId()) {
    if (recording || recordingBusy) { $('#conversation-message').textContent = 'Finish recording before disconnecting preview.'; return; }
    disconnectAvatar(); return;
  }
  await connectAvatar();
});
async function connectProjection() {
  if (projectionClient?.sessionId()) {
    if (recording || recordingBusy) { projectionError('Finish recording before disconnecting projection.'); return; }
    try { await disconnectProjection(); } catch (error) { projectionError(error.message); }
    return;
  }
  if (recording || recordingBusy) { projectionError('Finish recording before switching the stream.'); return; }
  if (sending || conversationChangeBusy) { projectionError('Wait for the message or conversation change to finish.'); return; }
  if (!serviceReady || !currentProfile || projectionBusy || previewBusy) return;
  const url = validProjectionUrl($('#projection-url').value);
  const token = $('#projection-token').value.trim();
  if (!url) {
    projectionError($('#projection-url').value.trim() ? 'Enter an HTTP(S) WHIP URL without credentials or query parameters.' : 'Choose a device first');
    if (!$('#projection-settings-dialog').open) $('#projection-settings-dialog').showModal();
    return;
  }
  if ($('#projection-discovered').selectedOptions[0]?.dataset.auth === 'bearer' && !token) {
    projectionError('This Head in Jar requires a bearer token'); return;
  }
  $('#projection-dialog-message').textContent = '';
  const restorePreview = Boolean(webRtcClient?.sessionId());
  projectionBusy = true;
  if (restorePreview) disconnectAvatar();
  const attempt = ++connectionGeneration;
  showProjectionState('connecting');
  let client;
  let failure = '';
  try {
    if (conversationBrain(currentProfile.brain.mode)) {
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
      conversationId: conversationBrain(currentProfile.brain.mode) ? currentProfile.brain.conversationId : '' });
    if (attempt !== connectionGeneration || client !== projectionClient) return;
    selectConversationTarget('projection');
    showProjectionState('connected');
    saveProjectionAddress();
    $('#projection-token').value = '';
    if ($('#projection-settings-dialog').open) $('#projection-settings-dialog').close();
  } catch (error) { if (attempt === connectionGeneration) failure = `Error: ${error.message}`; }
  finally {
    if (attempt === connectionGeneration) {
      if (client && !client.sessionId() && projectionClient === client) projectionClient = null;
      projectionBusy = false;
      showProjectionState(projectionClient?.sessionId() ? 'connected' : 'disconnected');
      if (failure) projectionError(failure);
      if (failure && restorePreview && serviceReady && !webRtcClient) void connectAvatar();
    }
  }
}
$('#connect-projection').addEventListener('click', () => { void connectProjection(); });
$('#projection-connect-settings')?.addEventListener('click', () => { void connectProjection(); });
$('#message-text').addEventListener('input', updateConversationControls);
$('#microphone-button').addEventListener('click', async () => {
  if (conversationChangeBusy) return;
  const token = microphoneState === 'capturing' ? microphoneGeneration : ++microphoneGeneration;
  let listenSender;
  try {
    if (continuousVoiceClient) return;
    if (microphoneState === 'capturing') { await asrClient.stop(); return; }
    if (!serviceReady || !currentProfile) return;
    if (conversationClient && activeSessionId()) await conversationClient.interrupt();
    if (token !== microphoneGeneration) return;
    asrClient?.dispose();
    const listenSession = activeSessionId();
    listenSender = listenSenderFor(listenSession);
    asrClient = createAsrClient({
      getUserMedia: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
      AudioContext: window.AudioContext,
      AudioWorkletNode: window.AudioWorkletNode,
      WebSocket: window.WebSocket,
      baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
      onState: (state, detail) => {
        if (['failed', 'ready', 'empty', 'idle'].includes(state)) listenSender?.close();
        if (token === microphoneGeneration) showMicrophoneState(state, detail);
      },
      onPcm: pcm => {
        if (activeSessionId() === listenSession) listenSender?.push(pcm);
        else listenSender?.close();
      },
      onCaptureEnd: () => listenSender?.close(),
      onPartial: text => {
        if (token === microphoneGeneration && ['capturing', 'transcribing'].includes(microphoneState) && text) {
          showMicrophoneState(microphoneState, `Hearing: ${text}`);
        }
      },
      onText: text => {
        if (token !== microphoneGeneration) return;
        $('#message-text').value = text;
        $('#conversation-message').textContent = 'Review the transcript and press Send.';
        updateConversationControls();
      },
    });
    await asrClient.start();
  } catch (error) {
    listenSender?.close();
    if (token === microphoneGeneration) showMicrophoneState('failed', error.message);
  }
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
  const listenSender = listenSenderFor(targetSession);
  let client;
  client = createContinuousVoiceClient({
    getUserMedia: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    AudioContext: window.AudioContext, AudioWorkletNode: window.AudioWorkletNode,
    WebSocket: window.WebSocket,
    baseUrl: `http://127.0.0.1:${currentProfile.liveTalking.port}`,
    onPcm: pcm => {
      if (activeSessionId() === targetSession) listenSender?.push(pcm);
      else listenSender?.close();
    },
    onCaptureEnd: () => listenSender?.close(),
    allowBargeIn: $('#handsfree-barge-in').checked,
    onState: (state, detail) => {
      if (['failed', 'idle'].includes(state)) listenSender?.close();
      if (continuousVoiceClient === client) showContinuousVoiceState(state, detail);
    },
    onPartial: text => {
      if (continuousVoiceClient !== client) return;
      const transcript = $('#handsfree-transcript');
      transcript.hidden = !text;
      transcript.textContent = text ? `Hearing: ${text}` : '';
    },
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
        pending: () => conversationBrain(currentProfile.brain.mode) && brainState.pending > 0, signal });
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
    $('#conversation-message').textContent = '';
    if (conversationBrain(currentProfile.brain.mode)) {
      const option = [...$('#brain-conversation').options].find(item => item.value === currentProfile.brain.conversationId);
      if (option && !option.dataset.hasMessage) {
        option.textContent = conversationLabel({}, [{ role: 'user', text }]);
        option.dataset.hasMessage = 'true';
      }
    }
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
    if (brainState.pending) $('#brain-turn-state').textContent = `Speech stopped; ${activeBrainName()} is saving the response…`;
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
    if (token === sessionGeneration) $('#speaking-state').textContent = speaking ? 'Speaking'
      : microphoneState === 'capturing' || ['listening', 'capturing'].includes($('#handsfree-state').dataset.state)
        ? 'Listening' : 'Ready';
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
  bridge.getSetup().then(async ({ profile, profiles, voiceReferences, avatars, secrets, recoveryError, testFixture: fixture }) => {
    testFixture = fixture;
    showProfile(profile);
    maybeAutoConnectPreview();
    showProfileList(profiles || []);
    avatarUI.applySnapshot(avatars || {});
    showKnownVoices(voiceReferences);
    showSecretStatus(secrets);
    if (recoveryError) { $('#setup-recovery').textContent = recoveryError; $('#setup-recovery').hidden = false; }
    await checkSetup();
    if (serviceReady && conversationBrain(currentProfile.brain.mode)) await refreshConversations();
  }).catch(error => message(error.message));
}
