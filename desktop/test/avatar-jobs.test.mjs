import test from 'node:test';import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { createAvatarJobs } from '../electron/avatar-jobs.mjs';
async function fixture(t,overrides={}) {
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-job-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'source.png');await writeFile(file,'image');
 const child=new EventEmitter();child.pid=4321;child.stdout=new EventEmitter();child.stderr=new EventEmitter();let alive=true;const signals=[],calls=[],events=[];
 const library={publish:async(_root,job)=>({id:job.avatarId,ready:true}),get:async()=>null};
 const jobs=createAvatarJobs({library,inspectCreation:async()=>[{id:'gpu',state:'ready',detail:'CUDA',action:''}],spawn:(...args)=>{calls.push(args);return child;},kill:(pid,signal)=>{if(signal===0){if(!alive)throw Object.assign(Error(),{code:'ESRCH'});return true;}signals.push([pid,signal]);if(signal==='SIGTERM'&&!overrides.delayed){alive=false;child.emit('exit',null,'SIGTERM');child.emit('close',null,'SIGTERM');}},emit:event=>events.push(event),shutdownTimeoutMs:10,...overrides});
 const input={root,python:'/usr/bin/python3',sourceFile:file,sourceKind:'image',name:'Аватар',model:'musetalk',parameters:{}};
 const close=(code=0)=>{alive=false;child.emit('exit',code);child.emit('close',code);};
 return{root,jobs,child,signals,calls,events,input,close};
}
async function until(predicate){for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error('condition timeout');}
test('one job owns its checking slot and fails exit without prepared result',async t=>{
 const f=await fixture(t);const job=await f.jobs.start(f.input);await assert.rejects(f.jobs.start(f.input));await until(()=>f.calls.length===1);
 assert.equal(f.calls[0][2].detached,true);assert.equal(f.calls[0][2].shell,false);
 f.close();await until(()=>!f.jobs.isBusy());assert.equal((await f.jobs.snapshot(f.root)).state,'failed');
 const data=JSON.parse(await readFile(path.join(f.root,'data/.studio-avatar-work',job.jobId,'job.json')));assert.equal(Object.hasOwn(data,'pid'),false);
});
test('chunked events ignore strangers and only publish after successful close',async t=>{
 let published=0;const f=await fixture(t,{library:{publish:async()=>{published++;return{ready:true};},get:async()=>null}});const job=await f.jobs.start(f.input);await until(()=>f.calls.length===1);
 const event=JSON.stringify({version:1,jobId:job.jobId,state:'running',stage:'generating',progress:45,message:''});
 f.child.stdout.emit('data','LT_AVATAR '+event.slice(0,20));f.child.stdout.emit('data',event.slice(20)+'\n');
 f.child.stdout.emit('data','LT_AVATAR '+JSON.stringify({version:2,jobId:job.jobId,state:'prepared',frameCount:1})+'\n');
 await until(()=>f.events.some(x=>x.progress===45));assert.equal(published,0);
 f.child.stdout.emit('data','LT_AVATAR '+JSON.stringify({version:1,jobId:job.jobId,state:'prepared',stage:'validating',progress:100,frameCount:1,message:''})+'\n');assert.equal(published,0);
 f.close();await until(()=>!f.jobs.isBusy());assert.equal(published,1);assert.equal((await f.jobs.snapshot(f.root)).state,'completed');
});
test('cancel and shutdown signal only the owned group and leave no active job',async t=>{
 const f=await fixture(t);const job=await f.jobs.start(f.input);await until(()=>f.calls.length===1);
 await Promise.all([f.jobs.cancel(job.jobId),f.jobs.shutdown()]);assert.deepEqual(f.signals,[[-4321,'SIGTERM']]);
 assert.equal((await f.jobs.snapshot(f.root)).state,'cancelled');assert.equal(f.jobs.isBusy(),false);
 f.child.stdout.emit('data','LT_AVATAR '+JSON.stringify({version:1,jobId:job.jobId,state:'prepared',frameCount:1})+'\n');
 assert.equal((await f.jobs.snapshot(f.root)).state,'cancelled');
});
test('a hung worker group is escalated within the shutdown timeout',async t=>{
 const f=await fixture(t,{delayed:true});const job=await f.jobs.start(f.input);await until(()=>f.calls.length===1);
 const cancel=f.jobs.cancel(job.jobId);await until(()=>f.signals.some(x=>x[1]==='SIGKILL'));f.close(1);await cancel;
 assert.deepEqual(f.signals,[[-4321,'SIGTERM'],[-4321,'SIGKILL']]);
});
test('checking cancellation aborts the probe without spawning',async t=>{
 const f=await fixture(t,{inspectCreation:async(_input,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 const job=await f.jobs.start(f.input);await f.jobs.cancel(job.jobId);assert.equal(f.calls.length,0);assert.equal((await f.jobs.snapshot(f.root)).state,'cancelled');
});
test('recover marks interrupted work without signalling its old PID',async t=>{
 const f=await fixture(t),jobId='c'.repeat(32),avatarId='studio_'+'d'.repeat(32);const dir=path.join(f.root,'data/.studio-avatar-work',jobId);await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,'job.json'),JSON.stringify({schemaVersion:1,...f.input,jobDir:dir,jobId,avatarId,state:'running',createdAt:'2026-09-28T00:00:00Z',updatedAt:'2026-09-28T00:00:00Z'}));
 assert.equal((await f.jobs.recover(f.root)).state,'interrupted');assert.deepEqual(f.signals,[]);assert.equal(f.calls.length,0);
});
test('recovery after publication completes instead of duplicating the avatar',async t=>{
 const f=await fixture(t,{library:{get:async()=>({ready:true,origin:'studio',model:'musetalk'}),publish:async()=>{throw Error('unexpected');}}}),jobId='e'.repeat(32);const dir=path.join(f.root,'data/.studio-avatar-work',jobId);await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,'job.json'),JSON.stringify({schemaVersion:1,...f.input,jobDir:dir,jobId,avatarId:'studio_'+'f'.repeat(32),state:'publishing',createdAt:'2026-09-28T00:00:00Z',updatedAt:'2026-09-28T00:00:00Z'}));
 assert.equal((await f.jobs.recover(f.root)).state,'completed');assert.deepEqual(f.signals,[]);assert.equal(f.calls.length,0);
});
test('retry uses the owned copy after the original disappears and creates fresh IDs',async t=>{
 const f=await fixture(t);const first=await f.jobs.start(f.input);await until(()=>f.calls.length===1);
 const dir=path.join(f.root,'data/.studio-avatar-work',first.jobId,'source');await mkdir(dir);await writeFile(path.join(dir,'input.png'),'saved source');
 f.close(1);await until(()=>!f.jobs.isBusy());await rm(f.input.sourceFile);
 const next=await f.jobs.retry({root:f.root,python:f.input.python,jobId:first.jobId});assert.notEqual(next.jobId,first.jobId);assert.notEqual(next.avatarId,first.avatarId);
 await until(()=>f.calls.length===2);const request=JSON.parse(await readFile(f.calls[1][1].at(-1)));assert.equal(request.sourceFile,path.join(dir,'input.png'));
 f.close(1);await until(()=>!f.jobs.isBusy());
});
test('oversized log lines are bounded and cannot impersonate a prepared event',async t=>{
 const f=await fixture(t);const job=await f.jobs.start(f.input);await until(()=>f.calls.length===1);
 f.child.stdout.emit('data','x'.repeat(1100000)+'\n');f.close(1);await until(()=>!f.jobs.isBusy());
 const log=await readFile(path.join(f.root,'data/.studio-avatar-work',job.jobId,'worker.log'));
 assert.ok(log.length<=1024*1024);assert.equal((await f.jobs.snapshot(f.root)).state,'failed');assert.ok((await f.jobs.snapshot(f.root)).errorMessage.length<=8192);
});
