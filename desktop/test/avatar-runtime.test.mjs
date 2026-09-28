import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { createAvatarRuntime } from '../electron/avatar-runtime.mjs';
import { createProfileStore } from '../electron/profile-store.mjs';import { normalizeProfile } from '../src/profile.mjs';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'studio-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));const profiles=createProfileStore(root);const profile=normalizeProfile({liveTalking:{root},speech:{referenceWav:path.join(root,'voice.wav'),referenceText:'Новое поле'}});profiles.save(profile);let busy=false,state={phase:'not-configured'},stops=0;
 const jobs={isBusy:()=>busy,start:async input=>{busy=true;return{jobId:'job',root:input.root};},retry:async()=>{busy=true;return{jobId:'retry'};},shutdown:async()=>{busy=false;},snapshot:async()=>null};
 const runtime=createAvatarRuntime({profiles,jobs,library:{get:async(_root,id)=>id==='portrait'?{id,name:'Портрет',ready:true,model:'musetalk'}:null,list:async()=>[],rename:async()=>null},sources:{resolve:async(token,root)=>{if(token!=='selected')throw Error('source');return{sourceFile:path.join(root,'source.png'),sourceKind:'image'};},choose:async()=>null},inspectCreation:async()=>[{id:'gpu',state:'ready',detail:'CUDA',action:''}],getServiceState:()=>state,stopProfile:async()=>{stops++;state={phase:'not-configured'};}});
 return{root,profile,profiles,jobs,runtime,setState:x=>{state=x;},getStops:()=>stops};}
test('selection derives model and preserves unsaved voice fields',async t=>{
 const f=await fixture(t),profile={...f.profile,speech:{...f.profile.speech,referenceText:'Несохранённый текст'}};
 const selected=await f.runtime.select(profile,'portrait',{stopServices:false});assert.equal(selected.schemaVersion,1);assert.deepEqual([selected.liveTalking.model,selected.liveTalking.avatarId],['musetalk','portrait']);assert.deepEqual(selected.speech,profile.speech);assert.deepEqual(f.profiles.get(selected.id),selected);
 await assert.rejects(f.runtime.select(profile,'missing',{stopServices:false}));
});
test('running profile requires an explicit stop before selection and never restarts',async t=>{
 const f=await fixture(t);f.setState({phase:'ready'});await assert.rejects(f.runtime.select(f.profile,'portrait',{stopServices:false}));assert.equal(f.getStops(),0);
 await f.runtime.select(f.profile,'portrait',{stopServices:true});assert.equal(f.getStops(),1);
});
test('creation works before voice setup and cannot compete with start or source changes',async t=>{
 const f=await fixture(t),input={root:f.root,python:f.profile.liveTalking.python,sourceToken:'selected',name:'Первый',model:'musetalk',parameters:{}};
 await f.runtime.create(input,{stopServices:false});assert.equal(f.jobs.isBusy(),true);
 await assert.rejects(f.runtime.create(input,{stopServices:false}));await assert.rejects(f.runtime.assertCanStart(f.profile));await assert.rejects(f.runtime.assertCanSave({...f.profile,liveTalking:{...f.profile.liveTalking,root:'/tmp/other'}}));
 await f.runtime.shutdown();assert.equal(f.jobs.isBusy(),false);
});
test('the runtime resolves its source token instead of accepting a supplied file path',async t=>{
 const f=await fixture(t);await assert.rejects(f.runtime.create({root:f.root,python:f.profile.liveTalking.python,sourceToken:'bad',sourceFile:'/etc/passwd',name:'A',model:'musetalk',parameters:{}},{stopServices:false}));assert.equal(f.jobs.isBusy(),false);
});
test('startup-only saved fields are blocked while a profile is running',async t=>{
 const f=await fixture(t);f.setState({phase:'ready',profileId:f.profile.id});
 await assert.rejects(f.runtime.assertCanSave({...f.profile,liveTalking:{...f.profile.liveTalking,model:'musetalk',avatarId:'portrait'}}));
 await f.runtime.assertCanSave(f.profile);
});
