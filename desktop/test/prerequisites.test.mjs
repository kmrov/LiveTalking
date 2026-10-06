import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPrerequisites } from '../electron/prerequisites.mjs';
import { normalizeProfile } from '../src/profile.mjs';

const root = '/home/user/Live Talking';
const base = normalizeProfile({ id: 'main', liveTalking: { root, python: `${root}/.venv/bin/python` }, speech: { mode: 'local', referenceWav: `${root}/voice.wav`, referenceText: 'Привет', asrVllm: '/opt/asr/bin/vllm', ttsVllm: '/opt/tts/bin/vllm' } });

function probes(overrides = {}) {
  return {
    exists: () => true,
    avatar: async lt => ({ready:true,model:lt.model}),
    fileReady: () => true,
    cachedModelReady: () => true,
    python: async () => ({ ok: true, detail: 'Python и модули доступны' }),
    model: async () => 'ready',
    port: async () => 'free',
    gpu: async () => true,
    ...overrides,
  };
}

test('prerequisite reports missing Python with an exact path and recovery action', async () => {
  const results = await inspectPrerequisites(base, probes({ exists: file => !file.endsWith('/.venv/bin/python') }));
  const python = results.find(item => item.id === 'python');
  assert.equal(python.state, 'missing');
  assert.match(python.detail, /\.venv\/bin\/python/);
  assert.match(python.action, /python|venv/i);
});

test('prerequisite blocks an unrelated listener on the configured port', async () => {
  const results = await inspectPrerequisites(base, probes({ port: async () => 'occupied' }));
  assert.equal(results.find(item => item.id === 'port').state, 'blocked');
});

test('prerequisite accepts a compatible LiveTalking health reply', async () => {
  const results = await inspectPrerequisites(base, probes({ port: async () => 'livetalking' }));
  assert.equal(results.find(item => item.id === 'port').state, 'ready');
});

test('prerequisite external speech mode does not require local vLLM executables; avatar still needs GPU', async () => {
  const profile = normalizeProfile({ ...base, speech: { ...base.speech, mode: 'external', asrUrl: 'http://127.0.0.1:8092', ttsUrl: 'http://127.0.0.1:8091', asrVllm: '', ttsVllm: '' } });
  const results = await inspectPrerequisites(profile, probes({ exists: file => !file.includes('/bin/vllm'), gpu: async () => false }));
  assert.equal(results.find(item => item.id === 'asr').state, 'ready');
  assert.equal(results.find(item => item.id === 'tts').state, 'ready');
  assert.equal(results.find(item => item.id === 'gpu').state, 'missing');
});

test('prerequisite reports missing adjacent LiveTalking checkout', async () => {
  const profile = normalizeProfile({ ...base, liveTalking: { ...base.liveTalking, root: '' } });
  const results = await inspectPrerequisites(profile, probes());
  assert.equal(results.find(item => item.id === 'checkout').state, 'missing');
  assert.match(results.find(item => item.id === 'checkout').action, /beside|folder/i);
});

test('prerequisite rejects a prepared avatar whose inference weights are absent', async () => {
  const results = await inspectPrerequisites(base, probes({ fileReady: file => !file.endsWith('/models/wav2lip.pth') }));
  assert.equal(results.find(item => item.id === 'avatar-model').state, 'missing');
  assert.match(results.find(item => item.id === 'avatar-model').detail, /wav2lip.pth/);
});

test('prerequisite rejects empty speech cache folders before cold model startup', async () => {
  const results = await inspectPrerequisites(base, probes({ model: async () => 'unavailable', cachedModelReady: () => false }));
  assert.equal(results.find(item => item.id === 'asr-model').state, 'missing');
  assert.equal(results.find(item => item.id === 'tts-model').state, 'missing');
});

test('OmniVoice local profile checks its Python and model instead of Qwen TTS weights', async () => {
  const profile = normalizeProfile({ ...base, speech: { ...base.speech, ttsEngine: 'omnivoice', omniPython: '/opt/omni/bin/python' } });
  const requested = [];
  const results = await inspectPrerequisites(profile, probes({
    model: async (_url, expected) => { requested.push(expected); return 'unavailable'; },
    omniPython: async () => ({ ok: true, detail: 'OmniVoice is installed' }),
    cachedOmniModelReady: () => false,
  }));
  assert.ok(requested.includes('k2-fsa/OmniVoice'));
  assert.equal(results.find(item => item.id === 'tts-model').state, 'missing');
  assert.match(results.find(item => item.id === 'tts-model').action, /OmniVoice/);
});

test('avatar preparation completeness and model compatibility block startup', async () => {
 for(const avatar of [null,{ready:false,reason:'Нет координат',model:'wav2lip'},{ready:true,model:'musetalk'}]) {
  const results=await inspectPrerequisites(base,probes({avatar:async()=>avatar}));
  assert.equal(results.find(x=>x.id==='avatar').state,'missing');
  assert.match(results.find(x=>x.id==='avatar').action,/select/i);
 }
});

test('generative runtime readiness is separate from downloadable speech models', async () => {
 for(const model of ['ditto','soulx']) {
  const profile={...base,liveTalking:{...base.liveTalking,model}};
  for(const ok of [false,true]) {
   const results=await inspectPrerequisites(profile,probes({generativeRuntime:async lt=>{assert.equal(lt.model,model);return {ok,detail:'Runtime checked'};},cachedModelReady:()=>false}));
   const runtime=results.find(x=>x.id==='avatar-runtime');assert.equal(runtime.state,ok?'ready':'missing');
   if(!ok)assert.match(runtime.action,new RegExp(`models/${model}/runtime.json`));
   assert.equal(results.some(x=>x.id==='avatar-model'),false);
   assert.equal(results.find(x=>x.id==='asr-model').state,'missing');
   assert.equal(results.find(x=>x.id==='tts-model').state,'missing');
  }
 }
});
