import path from 'node:path';
import { lstat, realpath, readdir, readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { normalizeAvatarName, validateAvatarId } from '../src/avatar-contract.mjs';

export async function checkedPath(base, ...parts) {
  const target=path.resolve(base,...parts), relative=path.relative(base,target);
  if (relative.startsWith('..'+path.sep) || relative==='..' || path.isAbsolute(relative)) throw new Error('Путь за пределами хранилища.');
  let current=base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Символические ссылки в хранилище не поддерживаются.'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  return target;
}
export async function avatarRoot(root) {
  if(typeof root!=='string' || !path.isAbsolute(root)) throw new Error('Выберите каталог LiveTalking.');
  const canonical=await realpath(root);
  return {root:canonical,avatars:await checkedPath(canonical,'data/avatars'),work:await checkedPath(canonical,'data/.studio-avatar-work')};
}
export async function atomicJson(file, value) {
  const temporary=`${file}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(temporary,file);
}
async function regular(file,limit=Infinity) {
  const info=await lstat(file);
  if(!info.isFile() || info.isSymbolicLink() || info.size===0 || info.size>limit) throw new Error(`Неполный или недопустимый файл: ${path.basename(file)}`);
  return info;
}
async function present(file) {try{await lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function frames(dir) {
  if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) throw new Error(`Недопустимый каталог ${path.basename(dir)}`);
  const names=(await readdir(dir)).filter(name=>/\.(png|jpe?g)$/i.test(name));
  if(!names.length) throw new Error(`Нет кадров: ${path.basename(dir)}`);
  const ids=new Set();
  for(const name of names) {
    const stem=path.parse(name).name;
    if(!/^\d+$/.test(stem) || ids.has(BigInt(stem).toString())) throw new Error('У кадров должны быть уникальные числовые имена.');
    ids.add(BigInt(stem).toString()); await regular(path.join(dir,name));
  }
  names.sort((a,b)=>{const x=BigInt(path.parse(a).name),y=BigInt(path.parse(b).name);return x<y?-1:x>y?1:0;});
  return {names,ids:[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)};
}
function sameIndices(a,b) {if(JSON.stringify(a.ids)!==JSON.stringify(b.ids)) throw new Error('Число и индексы кадров, лиц или масок не совпадают.');}

export function createAvatarLibrary({makeThumbnail=async()=>null,moveDirectoryNoReplace}={}) {
  let mutation=Promise.resolve();
  const serialize=operation=>{const result=mutation.then(operation);mutation=result.catch(()=>{});return result;};
  async function inspect(base,id) {
    const entry={id,name:id,model:null,ready:false,reason:'',origin:'existing',thumbnail:null};
    try {
      validateAvatarId(id);const dir=await checkedPath(base,id);
      const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Недопустимый каталог аватара.');
      const muse=await present(path.join(dir,'latents.pt')) || await present(path.join(dir,'mask_coords.pkl')) || await present(path.join(dir,'mask'));
      const ultra=await present(path.join(dir,'ultralight.pth'));
      if(muse&&ultra)throw new Error('Противоречивые файлы разных моделей.');
      entry.model=muse?'musetalk':ultra?'ultralight':'wav2lip';
      await regular(await checkedPath(base,id,'coords.pkl'));
      const full=await frames(await checkedPath(base,id,'full_imgs'));
      if(muse) {
        await regular(await checkedPath(base,id,'latents.pt'));await regular(await checkedPath(base,id,'mask_coords.pkl'));
        sameIndices(full,await frames(await checkedPath(base,id,'mask')));
        if(await present(path.join(dir,'face_imgs')))throw new Error('Противоречивые файлы разных моделей.');
      } else {
        sameIndices(full,await frames(await checkedPath(base,id,'face_imgs')));
        if(ultra)await regular(await checkedPath(base,id,'ultralight.pth'));
      }
      const manifest=path.join(dir,'studio-avatar.json');
      if(await present(manifest)) {
        try {
          await regular(await checkedPath(base,id,'studio-avatar.json'),65536);
          const meta=JSON.parse(await readFile(manifest,'utf8'));
          if(meta.schemaVersion!==1 || meta.avatarId!==id || meta.model!==entry.model || !['studio','existing'].includes(meta.origin) || meta.frameCount!==full.names.length) throw new Error('Схема или модель не соответствует файлам.');
          entry.name=normalizeAvatarName(meta.name);entry.origin=meta.origin;
          if(meta.sourceFile!==null && meta.sourceFile!==undefined) {
            if(!/^source\/input\.(png|jpg|jpeg|mp4|mov|mkv|avi)$/i.test(meta.sourceFile))throw new Error('Недопустимый путь исходника.');
            await regular(await checkedPath(base,id,meta.sourceFile));
          }
        }catch(e){throw new Error(`Повреждены метаданные: ${e.message}`);}
      }
      entry.ready=true;
      try {
        const preferred=await present(path.join(dir,'thumbnail.jpg'))?'thumbnail.jpg':path.join('full_imgs',full.names[0]);
        const file=await checkedPath(base,id,preferred);await regular(file,20*1024*1024);
        const value=await makeThumbnail(await readFile(file));
        if(typeof value==='string' && /^data:image\/(jpeg|png);base64,/.test(value) && value.length<=512*1024)entry.thumbnail=value;
      }catch { /* Preview failure does not disable otherwise valid data. */ }
      return {...entry,frameCount:full.names.length};
    }catch(error){entry.reason=error.message;return entry;}
  }
  async function list(root) {
    if(!root)return [];
    const base=(await avatarRoot(root)).avatars;
    let names;try{names=await readdir(base);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const entries=await Promise.all(names.filter(name=>!name.startsWith('.')).map(name=>inspect(base,name)));
    return entries.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  }
  async function get(root,id) {
    validateAvatarId(id);const base=(await avatarRoot(root)).avatars;
    if(!await present(await checkedPath(base,id)))return null;
    return inspect(base,id);
  }
  return {
    list,get,
    rename:(root,id,name)=>serialize(async()=>{
      name=normalizeAvatarName(name);const entry=await get(root,id);
      if(!entry?.ready)throw new Error(entry?.reason||'Аватар не найден.');
      const base=(await avatarRoot(root)).avatars,file=await checkedPath(base,id,'studio-avatar.json');
      const meta=await present(file)?JSON.parse(await readFile(file,'utf8')):{schemaVersion:1,avatarId:id,model:entry.model,origin:'existing',createdAt:null,frameCount:entry.frameCount,sourceFile:null,parameters:null};
      await atomicJson(file,{...meta,name});return get(root,id);
    }),
    publish:(root,job)=>serialize(async()=>{
      const paths=await avatarRoot(root);validateAvatarId(job.avatarId);
      if(!/^studio_[0-9a-f]{32}$/.test(job.avatarId) || !/^[0-9a-f-]{32,36}$/.test(job.jobId))throw new Error('Недопустимая задача подготовки.');
      const expected=await checkedPath(paths.work,job.jobId);
      if(path.resolve(job.jobDir)!==expected)throw new Error('Рабочий каталог не соответствует задаче.');
      const outputBase=await checkedPath(expected,'output'),staged=await checkedPath(outputBase,job.avatarId);
      const entry=await inspect(outputBase,job.avatarId);
      if(!entry.ready || entry.model!==job.model || entry.frameCount!==job.frameCount)throw new Error(entry.reason||'Результат подготовки не согласован.');
      if(!moveDirectoryNoReplace)throw new Error('Публикация результата не настроена.');
      await mkdir(paths.avatars,{recursive:true});
      const final=await checkedPath(paths.avatars,job.avatarId);
      if(await present(final))throw new Error('ID уже существует: аватар не перезаписан.');
      const sourceDir=await checkedPath(expected,'source');
      const sources=(await readdir(sourceDir)).filter(x=>/^input\.(png|jpe?g|mp4|mov|mkv|avi)$/i.test(x));
      if(sources.length!==1)throw new Error('Собственная копия исходника не найдена.');
      const source=await checkedPath(sourceDir,sources[0]);await regular(source);
      await mkdir(await checkedPath(staged,'source'),{recursive:true});
      const sourceFile=`source/${sources[0]}`;await copyFile(source,await checkedPath(staged,sourceFile));
      await atomicJson(await checkedPath(staged,'studio-avatar.json'),{schemaVersion:1,avatarId:job.avatarId,name:normalizeAvatarName(job.name),model:job.model,origin:'studio',createdAt:job.createdAt||new Date().toISOString(),frameCount:job.frameCount,sourceFile,parameters:job.parameters});
      await moveDirectoryNoReplace(staged,final,{root:paths.root,jobDir:expected,avatarId:job.avatarId,python:job.python});
      return get(paths.root,job.avatarId);
    }),
  };
}
