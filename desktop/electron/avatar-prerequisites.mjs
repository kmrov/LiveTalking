import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { normalizeAvatarCreation } from '../src/avatar-contract.mjs';

export function executeAvatarCommand(executable,argv,{cwd,timeout=30000,maxBuffer=1024*1024,signal,spawn=nodeSpawn}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,argv,{cwd,detached:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const stdoutDecoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve({stdout,stderr});};
    const stop=message=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}finish(new Error(message));};
    const abort=()=>stop('Проверка отменена.');
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) queueMicrotask(abort);
    const timer=setTimeout(()=>stop('Проверка подготовки превысила 30 секунд.'),timeout);
    child.stdout.on('data',chunk=>{if(settled)return;stdout+=stdoutDecoder.write(Buffer.from(chunk));if(Buffer.byteLength(stdout)>maxBuffer)stop('Слишком большой ответ подготовки.');});
    child.stderr.on('data',chunk=>{if(settled)return;stderr+=stderrDecoder.write(Buffer.from(chunk));if(Buffer.byteLength(stderr)>maxBuffer)stop('Слишком большой журнал подготовки.');});
    child.on('error',finish);
    child.on('close',code=>{
      if(settled)return;
      stdout+=stdoutDecoder.end();stderr+=stderrDecoder.end();
      if(Buffer.byteLength(stdout)>maxBuffer||Buffer.byteLength(stderr)>maxBuffer)return finish(new Error('Слишком большой ответ подготовки.'));
      finish(code===0?null:new Error(stderr.slice(-8192)||stdout.slice(-8192)||`Python завершился с кодом ${code}.`));
    });
  });
}
export async function runAvatarCommand(input,mode,{execute=executeAvatarCommand,signal}={}) {
  if(!['probe','preview','publish'].includes(mode) || !path.isAbsolute(input.root) || !path.isAbsolute(input.python))throw new Error('Некорректная команда подготовки.');
  const temporary=await mkdtemp(path.join(os.tmpdir(),'studio-avatar-command-'));
  try {
    const file=path.join(temporary,'request.json');await writeFile(file,JSON.stringify(input),{mode:0o600});
    const {stdout}=await execute(input.python,['-u',path.join(input.root,'scripts/prepare_desktop_avatar.py'),'--'+mode,file],{cwd:input.root,timeout:30000,maxBuffer:1024*1024,signal});
    const prefix=`LT_AVATAR_${mode.toUpperCase()} `;
    const lines=String(stdout).split('\n').filter(x=>x.startsWith(prefix));
    if(lines.length!==1 || lines[0].length>65536)throw new Error('Некорректный ответ Python-подготовки.');
    const value=JSON.parse(lines[0].slice(prefix.length));
    if(mode==='preview') {
      const expected=path.join(temporary,'preview.jpg');
      if(value.path!==expected)throw new Error('Недопустимый путь миниатюры.');
      const info=await lstat(expected);if(!info.isFile()||info.isSymbolicLink()||info.size>384*1024)throw new Error('Миниатюра слишком большая.');
      return 'data:image/jpeg;base64,'+(await readFile(expected)).toString('base64');
    }
    return value;
  } finally {await rm(temporary,{recursive:true,force:true});}
}
export async function inspectAvatarPrerequisites(input,{runProbe,signal}={}) {
  const creation=normalizeAvatarCreation({name:input.name,model:input.model,kind:input.sourceKind,parameters:input.parameters});
  const probe=runProbe??(request=>runAvatarCommand(request,'probe',{signal}));
  const result=await probe({...input,parameters:creation.parameters,name:creation.name});
  if(!Array.isArray(result)||!result.length||result.some(x=>!x||typeof x.id!=='string'||!['ready','missing','blocked'].includes(x.state)||typeof x.detail!=='string'||typeof x.action!=='string'))throw new Error('Некорректный результат проверки подготовки.');
  return result;
}
