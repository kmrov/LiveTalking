import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { avatarRoot, checkedPath, atomicJson } from './avatar-library.mjs';
import { normalizeAvatarCreation } from '../src/avatar-contract.mjs';
import { inspectAvatarPrerequisites } from './avatar-prerequisites.mjs';

const terminal=new Set(['completed','failed','cancelled','interrupted']);
const phases=new Set(['checking','copying','normalizing','generating','validating']);
const fields=['schemaVersion','jobId','avatarId','root','name','model','sourceKind','state','stage','progress','errorMessage','logPath','createdAt','updatedAt'];
export function createAvatarJobs({library,inspectCreation=inspectAvatarPrerequisites,spawn=nodeSpawn,kill=process.kill.bind(process),emit=()=>{},now=()=>new Date().toISOString(),schedule=setTimeout,cancelSchedule=clearTimeout,shutdownTimeoutMs=5000}={}) {
  let active=null;
  const publicRecord=record=>Object.fromEntries(fields.map(key=>[key,record[key]??null]));
  const timestamp=()=>{const value=now();return typeof value==='number'?new Date(value).toISOString():value;};
  function persist(owner) {
    owner.record.updatedAt=timestamp();const copy=structuredClone(owner.record);
    owner.writes=owner.writes.then(()=>atomicJson(path.join(owner.record.jobDir,'job.json'),copy));
    return owner.writes;
  }
  function publish(owner) {emit(publicRecord(owner.record));}
  function update(owner,values) {Object.assign(owner.record,values);publish(owner);return persist(owner);}
  async function finish(owner,state,errorMessage='') {
    if(terminal.has(owner.record.state))return;
    try{await update(owner,{state,errorMessage,progress:state==='completed'?100:owner.record.progress});await owner.writes;}
    finally{if(active===owner)active=null;owner.resolveFinished();}
  }
  async function readRecords(root) {
    if(!root)return [];
    const paths=await avatarRoot(root);let names;
    try{names=await readdir(paths.work);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const result=[];
    for(const jobId of names.filter(x=>/^[0-9a-f-]{32,36}$/.test(x))) {
      try{
        const jobDir=await checkedPath(paths.work,jobId),file=await checkedPath(jobDir,'job.json'),info=await lstat(file);
        if(!info.isFile()||info.isSymbolicLink()||info.size>65536)continue;
        const value=JSON.parse(await readFile(file,'utf8'));
        if(value.schemaVersion!==1 || value.jobId!==jobId || value.root!==paths.root || value.jobDir!==jobDir || !/^studio_[0-9a-f]{32}$/.test(value.avatarId))continue;
        value.logPath=path.join(jobDir,'worker.log');result.push(value);
      }catch { /* An invalid job record cannot authorize retry or deletion. */ }
    }
    return result.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async function snapshot(root) {
    if(active?.record && (!root || active.record.root===(await avatarRoot(root)).root))return publicRecord(active.record);
    const records=await readRecords(root);return records[0]?publicRecord(records[0]):null;
  }
  async function run(owner) {
    try {
      const checks=await inspectCreation(owner.record,{signal:owner.controller.signal});
      if(owner.cancelled)return await finish(owner,'cancelled');
      const blockers=checks.filter(x=>x.state!=='ready');
      if(blockers.length)throw new Error(blockers.map(x=>x.detail).join('; '));
      await update(owner,{state:'running'});
      if(owner.cancelled)return await finish(owner,'cancelled');
      const requestFile=path.join(owner.record.jobDir,'request.json');
      await writeFile(requestFile,JSON.stringify(owner.record),{mode:0o600});
      if(owner.cancelled)return await finish(owner,'cancelled');
      const child=spawn(owner.record.python,['-u',path.join(owner.record.root,'scripts/prepare_desktop_avatar.py'),'--job',requestFile],{cwd:owner.record.root,detached:true,shell:false,stdio:['ignore','pipe','pipe']});
      owner.child=child;owner.log='';let buffer='',dropping=false;
      const log=chunk=>{
        owner.log=(owner.log+String(chunk));
        const bytes=Buffer.from(owner.log);if(bytes.length>1024*1024)owner.log=bytes.subarray(-1024*1024).toString('utf8');
        owner.writes=owner.writes.then(()=>writeFile(owner.record.logPath,owner.log,{mode:0o600}));
      };
      const line=value=>{
        if(!value.startsWith('LT_AVATAR '))return;
        try{
          const event=JSON.parse(value.slice(10));
          if(event.version!==1||event.jobId!==owner.record.jobId||owner.closed||owner.cancelled||terminal.has(owner.record.state))return;
          if(!['running','prepared','failed'].includes(event.state)||!phases.has(event.stage)||!Number.isFinite(event.progress)||event.progress<0||event.progress>100)return;
          if(event.state==='prepared') {
            if(event.stage==='validating'&&Number.isInteger(event.frameCount)&&event.frameCount>0)owner.prepared=event;
          }else if(event.state==='failed')owner.workerError=String(event.message||'Подготовка завершилась ошибкой.').slice(0,8192);
          else {owner.record.stage=event.stage;owner.record.progress=Math.min(99,event.progress);publish(owner);void persist(owner).catch(()=>{});}
        }catch { /* Nonprotocol output remains in the bounded log. */ }
      };
      child.stdout.on('data',chunk=>{
        if(owner.closed)return;log(chunk);
        for(const char of chunk.toString()) {
          if(char==='\n'){if(!dropping)line(buffer);buffer='';dropping=false;}
          else if(!dropping){buffer+=char;if(Buffer.byteLength(buffer)>65536){buffer='';dropping=true;}}
        }
      });
      child.stderr.on('data',chunk=>{if(!owner.closed)log(chunk);});
      child.once('error',error=>{owner.workerError=error.message;if(!child.pid){owner.closed=true;void finish(owner,owner.cancelled?'cancelled':'failed',error.message).catch(owner.rejectFinished);}});
      child.once('close',code=>{
        owner.closed=true;
        void (async()=>{
          try {
            if(buffer&&!dropping)line(buffer);
            await owner.writes;
            if(owner.cancelled)return await finish(owner,'cancelled');
            if(code!==0||owner.workerError||!owner.prepared)throw new Error(owner.workerError||owner.log.slice(-8192)||'Python завершился без подтверждённого результата подготовки.');
            await update(owner,{state:'publishing',stage:'publishing',frameCount:owner.prepared.frameCount,progress:99});
            const result=await library.publish(owner.record.root,owner.record);
            if(!result?.ready)throw new Error('Готовый аватар не прошёл проверку.');
            for(const item of ['input','output'])await rm(await checkedPath(owner.record.jobDir,item),{recursive:true,force:true});
            await finish(owner,'completed');
          }catch(error){await finish(owner,'failed',error.message);}
        })().catch(owner.rejectFinished);
      });
      if(owner.cancelled)void stopOwner(owner);
    } catch(error) {await finish(owner,owner.cancelled?'cancelled':'failed',owner.cancelled?'':error.message);}
  }
  async function start(input) {
    if(active)throw new Error('Подготовка уже выполняется. Дождитесь завершения или отмените её.');
    const owner={cancelled:false,child:null,closed:false,controller:new AbortController(),writes:Promise.resolve()};
    owner.finished=new Promise((resolve,reject)=>{owner.resolveFinished=resolve;owner.rejectFinished=reject;});
    void owner.finished.catch(()=>{});active=owner;
    try {
      const creation=normalizeAvatarCreation({name:input.name,model:input.model,kind:input.sourceKind,parameters:input.parameters});
      const paths=await avatarRoot(input.root),jobId=randomUUID(),avatarId='studio_'+randomUUID().replaceAll('-','');
      const jobDir=await checkedPath(paths.work,jobId);await mkdir(jobDir,{recursive:true,mode:0o700});
      owner.record={schemaVersion:1,...input,...creation,root:paths.root,sourceKind:creation.kind,jobId,avatarId,jobDir,state:'checking',stage:'checking',progress:0,errorMessage:'',logPath:path.join(jobDir,'worker.log'),createdAt:timestamp(),updatedAt:timestamp()};
      delete owner.record.kind;
      await persist(owner);publish(owner);
      void run(owner).catch(owner.rejectFinished);
      return publicRecord(owner.record);
    } catch(error){active=null;owner.resolveFinished();throw error;}
  }
  function groupAlive(owner) {
    if(!owner.child?.pid)return false;
    try {kill(-owner.child.pid,0);return true;}catch(error){return error.code!=='ESRCH';}
  }
  async function stopOwner(owner) {
    if(owner.stopPromise)return owner.stopPromise;
    owner.stopPromise=(async()=>{
      if(owner.record?.state==='publishing')return owner.finished;
      owner.cancelled=true;owner.controller.abort();
      if(owner.record)await update(owner,{state:'cancelling'});
      if(owner.child?.pid && !owner.closed) {
        try{kill(-owner.child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
        await new Promise(resolve=>{
          const timer=schedule(()=>{if(groupAlive(owner)){try{kill(-owner.child.pid,'SIGKILL');}catch{}}resolve();},shutdownTimeoutMs);
          owner.finished.then(()=>{if(!groupAlive(owner)){cancelSchedule(timer);resolve();}});
        });
      }
      return owner.finished;
    })();
    return owner.stopPromise;
  }
  async function cancel(jobId) {
    if(!active||active.record?.jobId!==jobId)throw new Error('Активная задача не найдена.');
    if(active.record.state==='publishing')throw new Error('Аватар уже сохраняется; дождитесь завершения.');
    const owner=active;await stopOwner(owner);return publicRecord(owner.record);
  }
  async function recover(root) {
    const records=await readRecords(root);
    for(const record of records) {
      if(terminal.has(record.state)||active?.record?.jobId===record.jobId)continue;
      const result=await library.get(record.root,record.avatarId);
      record.state=result?.ready&&result.origin==='studio'&&result.model===record.model?'completed':'interrupted';
      record.errorMessage=record.state==='interrupted'?'Подготовка прервана закрытием приложения. Можно повторить.':'';
      record.updatedAt=timestamp();if(record.state==='completed')record.progress=100;
      await atomicJson(path.join(record.jobDir,'job.json'),record);
    }
    return snapshot(root);
  }
  async function retry({root,python,jobId}) {
    const old=(await readRecords(root)).find(x=>x.jobId===jobId);
    if(!old||!['failed','cancelled','interrupted'].includes(old.state))throw new Error('Эту задачу нельзя повторить.');
    const sourceDir=await checkedPath(old.jobDir,'source');let names;
    try{names=await readdir(sourceDir);}catch{throw new Error('Копия исходника не сохранена. Выберите файл заново.');}
    const files=names.filter(x=>/^input\.(png|jpe?g|mp4|mov|mkv|avi)$/i.test(x));
    if(files.length!==1)throw new Error('Копия исходника не сохранена. Выберите файл заново.');
    const sourceFile=await checkedPath(sourceDir,files[0]);const info=await lstat(sourceFile);
    if(!info.isFile()||!info.size)throw new Error('Сохранённый исходник повреждён.');
    return start({root,python,sourceFile,sourceKind:old.sourceKind,name:old.name,model:old.model,parameters:old.parameters});
  }
  return {start,retry,cancel,recover,snapshot,isBusy:()=>Boolean(active),shutdown:async()=>{if(active)await stopOwner(active);}};
}
