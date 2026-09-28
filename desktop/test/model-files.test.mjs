import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedModelReady, speechCacheRoot } from '../electron/prerequisites.mjs';

test('cached model requires actual config and all indexed weight shards', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lt-model-'));
  try {
    const revision = 'a'.repeat(40);
    const snapshot = path.join(root, 'snapshots', revision);
    mkdirSync(snapshot, { recursive: true });
    mkdirSync(path.join(root, 'refs')); writeFileSync(path.join(root, 'refs/main'), revision);
    assert.equal(cachedModelReady(root), false);
    for (const name of ['config.json', 'tokenizer_config.json', 'preprocessor_config.json', 'vocab.json', 'merges.txt']) writeFileSync(path.join(snapshot, name), '{}');
    writeFileSync(path.join(snapshot, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { a: 'one.safetensors', b: 'two.safetensors' } }));
    writeFileSync(path.join(snapshot, 'one.safetensors'), 'weights');
    assert.equal(cachedModelReady(root), false);
    writeFileSync(path.join(snapshot, 'two.safetensors'), 'weights');
    assert.equal(cachedModelReady(root), true);
    assert.equal(cachedModelReady(root, true), false, 'TTS also needs the speech tokenizer weights');
    mkdirSync(path.join(snapshot, 'speech_tokenizer'));
    writeFileSync(path.join(snapshot, 'speech_tokenizer/config.json'), '{}');
    writeFileSync(path.join(snapshot, 'speech_tokenizer/preprocessor_config.json'), '{}');
    writeFileSync(path.join(snapshot, 'speech_tokenizer/model.safetensors'), 'weights');
    assert.equal(cachedModelReady(root, true), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cache requires the active main revision and text and speech tokenizer files',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'lt-active-model-'));const revision='a'.repeat(40);const snapshot=path.join(root,'snapshots',revision);
 try{
  mkdirSync(snapshot,{recursive:true});for(const name of ['config.json','tokenizer_config.json','preprocessor_config.json','model.safetensors'])writeFileSync(path.join(snapshot,name),'data');
  assert.equal(cachedModelReady(root),false,'an unreferenced snapshot cannot start offline');
  mkdirSync(path.join(root,'refs'));writeFileSync(path.join(root,'refs/main'),revision);
  assert.equal(cachedModelReady(root),false,'missing vocabulary cannot be loaded');
  writeFileSync(path.join(snapshot,'vocab.json'),'{}');writeFileSync(path.join(snapshot,'merges.txt'),'data');assert.equal(cachedModelReady(root),true);
  mkdirSync(path.join(snapshot,'speech_tokenizer'));for(const name of ['config.json','model.safetensors'])writeFileSync(path.join(snapshot,'speech_tokenizer',name),'data');
  assert.equal(cachedModelReady(root,true),false);writeFileSync(path.join(snapshot,'speech_tokenizer/preprocessor_config.json'),'{}');assert.equal(cachedModelReady(root,true),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('speech cache follows launcher precedence and does not create an adjacent cache that hides existing models',()=>{
 const root='/workspace/LiveTalking',home='/user';
 assert.equal(speechCacheRoot(root,{home,env:{HF_HUB_CACHE:'/hub',HF_HOME:'/hf'},exists:()=>true}),'/hub');
 assert.equal(speechCacheRoot(root,{home,env:{HF_HOME:'/hf'},exists:()=>true}),'/hf/hub');
 assert.equal(speechCacheRoot(root,{home,env:{},exists:()=>true}),'/workspace/.hf-cache-qwen/hub');
 assert.equal(speechCacheRoot(root,{home,env:{XDG_CACHE_HOME:'/cache'},exists:()=>false}),'/cache/huggingface/hub');
 assert.equal(speechCacheRoot(root,{home,env:{},exists:()=>false}),'/user/.cache/huggingface/hub');
});
