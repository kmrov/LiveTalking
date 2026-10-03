import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as downloads from '../electron/model-downloads.mjs';

async function fixture(t) {
 const temporary=await mkdtemp(path.join(os.tmpdir(),'studio-model-download-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
 const child=new EventEmitter();child.pid=12345;child.stdout=new EventEmitter();child.stderr=new EventEmitter();const signals=[],events=[];
 let request;
 const runner=downloads.createModelDownloads({temporaryRoot:temporary,spawn:(_python,args)=>{request=readFile(args.at(-1),'utf8').then(JSON.parse);return child;},kill:(pid,signal)=>{signals.push([pid,signal]);child.emit('close',null,'SIGTERM');},emit:value=>events.push(value)});
 const profile={liveTalking:{root:temporary,python:'/usr/bin/python3',model:'wav2lip'},speech:{mode:'local'}};
 return{runner,child,signals,events,profile,request:()=>request};
}
async function until(predicate){for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('condition timeout');}
test('startup download reports parsed UTF-8 progress and requires successful completion',async t=>{
 const f=await fixture(t);const pending=f.runner.prepare(f.profile);await until(()=>f.request());
 assert.deepEqual(await f.request(),{root:f.profile.liveTalking.root,model:'wav2lip',speechMode:'local'});
 const line=Buffer.from('LT_MODELS '+JSON.stringify({version:1,state:'downloading',file:'model.safetensors',label:'Голос Qwen',downloadedBytes:5,totalBytes:10,progress:50})+'\n');
 const cut=line.indexOf(Buffer.from('Голос'))+1;f.child.stdout.emit('data',line.subarray(0,cut));f.child.stdout.emit('data',line.subarray(cut));
 assert.equal(f.runner.snapshot().label,'Голос Qwen');assert.equal(f.runner.snapshot().progress,50);
 f.child.stdout.emit('data','LT_MODELS {"version":1,"state":"completed"}\n');f.child.emit('close',0);await pending;
 assert.equal(f.runner.snapshot().state,'completed');assert.equal(f.runner.isBusy(),false);
});
test('stop cancels only the owned model downloader and permits a later repeat',async t=>{
 const f=await fixture(t);const pending=f.runner.prepare(f.profile);const failure=assert.rejects(pending,/cancel/i);await until(()=>f.request());
 await f.runner.stop();await failure;
 assert.deepEqual(f.signals,[[-12345,'SIGTERM']]);assert.equal(f.runner.snapshot().state,'cancelled');assert.equal(f.runner.isBusy(),false);
 const previousRequest=f.request();const repeat=f.runner.prepare(f.profile);await until(()=>f.request()!==previousRequest);
 f.child.stdout.emit('data','LT_MODELS {"version":1,"state":"completed"}\n');f.child.emit('close',0);await repeat;
 assert.equal(f.runner.snapshot().state,'completed');
});
test('zero exit without completed event cannot advertise successful model installation',async t=>{
 const f=await fixture(t);const pending=f.runner.prepare(f.profile);const failure=assert.rejects(pending,/confirm|result/i);await until(()=>f.request());f.child.emit('close',0);await failure;
 assert.equal(f.runner.snapshot().state,'failed');
});

test('startup downloads missing weights only after all other requirements are ready and rechecks before start',async()=>{
 const calls=[];let installed=false;
 const profile={};const inspect=async()=>{calls.push('check');return [{id:'python',state:'ready'},{id:'avatar-model',state:installed?'ready':'missing',detail:'Missing weights'}];};
 await downloads.prepareProfileModels(profile,{inspect,download:async()=>{calls.push('download');installed=true;}});
 assert.deepEqual(calls,['check','download','check']);
 calls.length=0;await downloads.prepareProfileModels(profile,{inspect,download:async()=>calls.push('download')});assert.deepEqual(calls,['check']);
 await assert.rejects(downloads.prepareProfileModels(profile,{inspect:async()=>[{id:'gpu',state:'missing',detail:'No GPU'},{id:'avatar-model',state:'missing'}],download:async()=>assert.fail('must not download')}),/No GPU/);
 await assert.rejects(downloads.prepareProfileModels(profile,{inspect:async()=>[{id:'tts-model',state:'missing',detail:'Still missing'}],download:async()=>{}}),/Still missing/);
});
test('stop before worker spawn releases ownership and does not launch a downloader',async t=>{
 const f=await fixture(t);const pending=f.runner.prepare(f.profile);const failure=assert.rejects(pending,/cancel/i);await f.runner.stop();await failure;
 assert.equal(f.request(),undefined);assert.equal(f.runner.isBusy(),false);assert.deepEqual(f.signals,[]);
});
