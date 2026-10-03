import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,symlink,rename } from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import { createAvatarSources } from '../electron/avatar-sources.mjs';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'studio-source-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'Мой портрет.png');await writeFile(file,'photo');return{root,file,profile:{liveTalking:{root,python:'/usr/bin/python3'}}};}
test('source tokens hide paths and bind file identity and root',async t=>{
 const {root,file,profile}=await fixture(t);const sources=createAvatarSources({chooseFile:async()=>file,inspectPreview:async()=> 'data:image/jpeg;base64,QQ=='});
 const selection=await sources.choose(profile);assert.equal(selection.fileName,'Мой портрет.png');assert.equal(selection.kind,'image');assert.equal(Object.hasOwn(selection,'sourceFile'),false);
 const resolved=await sources.resolve(selection.token,root);assert.equal(resolved.sourceFile,file);assert.equal(resolved.sourceKind,'image');assert.match(resolved.sourceFingerprint,/^\d+:\d+:\d+:\d+$/);
 await assert.rejects(sources.resolve(selection.token,os.tmpdir()));await assert.rejects(sources.resolve('unknown',root));
 await writeFile(file,'changed photo');await assert.rejects(sources.resolve(selection.token,root),/again|changed/i);
});
test('replacement, symlink and deletion require a new source selection',async t=>{
 const {root,file,profile}=await fixture(t);const sources=createAvatarSources({chooseFile:async()=>file,inspectPreview:async()=>null});
 const first=await sources.choose(profile);await rename(file,file+'.old');await writeFile(file,'photo');await assert.rejects(sources.resolve(first.token,root));
 const next=await sources.choose(profile);await rm(file);await symlink(file+'.old',file);await assert.rejects(sources.resolve(next.token,root));
 await rm(file);await assert.rejects(sources.resolve(first.token,root));
});
test('cancel, bounded tokens and preview failures are recoverable',async t=>{
 const {root,file,profile}=await fixture(t);assert.equal(await createAvatarSources({chooseFile:async()=>null}).choose(profile),null);
 const sources=createAvatarSources({chooseFile:async()=>file,inspectPreview:async()=> 'data:image/jpeg;base64,'+'a'.repeat(600000)});
 const first=await sources.choose(profile);assert.equal(first.preview,null);
 for(let i=0;i<32;i++)await sources.choose(profile);
 await assert.rejects(sources.resolve(first.token,root));sources.forgetAll();
 const failed=createAvatarSources({chooseFile:async()=>file,inspectPreview:async()=>{throw Error('decoder');}});assert.equal((await failed.choose(profile)).preview,null);
});
