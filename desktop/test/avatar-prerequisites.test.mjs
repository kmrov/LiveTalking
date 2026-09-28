import test from 'node:test';import assert from 'node:assert/strict';
import { inspectAvatarPrerequisites, runAvatarCommand } from '../electron/avatar-prerequisites.mjs';
const input={root:'/tmp/Studio',python:'/usr/bin/python3',sourceFile:'/tmp/портрет.png',sourceKind:'image',name:'Портрет',model:'musetalk',parameters:{}};
test('creation prerequisites exclude voice, Qwen and an existing avatar',async()=>{
 const checks=await inspectAvatarPrerequisites(input,{runProbe:async request=>{assert.equal(request.sourceFile,input.sourceFile);return[{id:'gpu',state:'ready',detail:'CUDA',action:''}];}});
 assert.deepEqual(checks.map(x=>x.id),['gpu']);assert.equal(checks[0].state,'ready');
});
test('malformed and unsuccessful probes never report readiness',async()=>{
 for(const value of [null,{},[{id:'gpu',state:'surprise'}]])await assert.rejects(inspectAvatarPrerequisites(input,{runProbe:async()=>value}));
 await assert.rejects(inspectAvatarPrerequisites(input,{runProbe:async()=>{throw Error('timeout');}}));
});
test('command protocol validates output and exit while keeping paths as arguments',async()=>{
 const calls=[];
 const execute=async(executable,argv)=>{calls.push({executable,argv});return{stdout:'noise\nLT_AVATAR_PROBE [{"id":"gpu","state":"missing","detail":"CUDA unavailable","action":"Fix CUDA"}]\n',stderr:''};};
 const result=await runAvatarCommand(input,'probe',{execute});assert.equal(result[0].state,'missing');assert.equal(calls[0].executable,'/usr/bin/python3');assert.ok(calls[0].argv.includes('--probe'));
 await assert.rejects(runAvatarCommand(input,'probe',{execute:async()=>({stdout:'not json'})}));
 await assert.rejects(runAvatarCommand(input,'probe',{execute:async()=>{throw Error('exit 1');}}));
});
