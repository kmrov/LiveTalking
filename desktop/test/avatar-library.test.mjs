import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAvatarLibrary } from '../electron/avatar-library.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-catalog-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return root;
}
async function avatar(root,id,model='wav2lip',indices=['2','10']) {
 const dir=path.join(root,'data/avatars',id); await mkdir(dir,{recursive:true});
 for(const folder of model==='musetalk'?['full_imgs','mask']:['full_imgs','face_imgs']) {
  await mkdir(path.join(dir,folder));
  for(const index of indices) await writeFile(path.join(dir,folder,`${index}.png`),'image');
 }
 await writeFile(path.join(dir,'coords.pkl'),'coords');
 if(model==='musetalk') for(const f of ['mask_coords.pkl','latents.pt']) await writeFile(path.join(dir,f),'data');
 if(model==='ultralight') await writeFile(path.join(dir,'ultralight.pth'),'weights');
 return dir;
}
test('catalog detects models and keeps corrupt entries isolated',async t=>{
 const root=await fixture(t);
 await avatar(root,'Русский'); await avatar(root,'m','musetalk'); await avatar(root,'u','ultralight');
 const bad=await avatar(root,'broken'); await writeFile(path.join(bad,'studio-avatar.json'),'{bad');
 await mkdir(path.join(root,'data/.studio-avatar-work/task'),{recursive:true});
 const entries=await createAvatarLibrary().list(root);
 assert.equal(entries.length,4);
 assert.deepEqual(entries.filter(x=>x.ready).map(x=>x.model).sort(),['musetalk','ultralight','wav2lip']);
 assert.equal(entries.find(x=>x.id==='broken').ready,false);
 assert.match(entries.find(x=>x.id==='broken').reason,/metadata/i);
});
test('incomplete, conflicting, duplicate and nonnumeric artifacts cannot be selected',async t=>{
 const root=await fixture(t);
 const a=await avatar(root,'partial','musetalk');await rm(path.join(a,'mask/10.png'));
 const b=await avatar(root,'conflict','musetalk');await writeFile(path.join(b,'ultralight.pth'),'weights');
 const c=await avatar(root,'duplicate');await writeFile(path.join(c,'full_imgs/02.jpg'),'image');
 const d=await avatar(root,'names');await writeFile(path.join(d,'full_imgs/photo.png'),'image');
 const entries=await createAvatarLibrary().list(root);
 assert.equal(entries.every(x=>!x.ready),true);
});
test('renaming preserves original data and permits duplicate display names',async t=>{
 const root=await fixture(t),lib=createAvatarLibrary();
 const a=await avatar(root,'a'),b=await avatar(root,'b');
 await lib.rename(root,'a','Персона');await lib.rename(root,'b','Персона');
 assert.equal((await lib.get(root,'a')).name,'Персона');
 assert.equal(await readFile(path.join(a,'coords.pkl'),'utf8'),'coords');
 const manifest=JSON.parse(await readFile(path.join(b,'studio-avatar.json'),'utf8'));
 assert.equal(manifest.sourceFile,null);assert.equal(manifest.origin,'existing');
 await writeFile(path.join(a,'studio-avatar.json'),'{broken');
 await assert.rejects(lib.rename(root,'a','Other'));
 assert.equal(await readFile(path.join(a,'studio-avatar.json'),'utf8'),'{broken');
});
test('symlinked directories and artifacts do not escape the catalog',async t=>{
 const root=await fixture(t),external=await fixture(t);
 const outside=await avatar(external,'external');
 await mkdir(path.join(root,'data/avatars'),{recursive:true});
 await symlink(outside,path.join(root,'data/avatars/link'));
 const dir=await avatar(root,'file-link');await rm(path.join(dir,'coords.pkl'));
 await symlink(path.join(outside,'coords.pkl'),path.join(dir,'coords.pkl'));
 const entries=await createAvatarLibrary().list(root);
 assert.equal(entries.some(x=>x.ready),false);
 await assert.rejects(createAvatarLibrary().get(root,'../external'));
});
test('publication preserves source and refuses a collision or incomplete result',async t=>{
 const root=await fixture(t),id='studio_'+ 'a'.repeat(32),jobId='a'.repeat(32);
 const jobDir=path.join(root,'data/.studio-avatar-work',jobId);
 await mkdir(path.join(jobDir,'output'),{recursive:true});
 const staged=await avatar(path.join(jobDir,'output-root'),id);
 await rename(staged,path.join(jobDir,'output',id));
 await mkdir(path.join(jobDir,'source'));await writeFile(path.join(jobDir,'source/input.mp4'),'source');
 const job={root,jobId,jobDir,avatarId:id,name:'Портрет',model:'wav2lip',sourceKind:'video',sourceFile:'source/input.mp4',parameters:{},frameCount:2,python:'/usr/bin/python3'};
 const lib=createAvatarLibrary({moveDirectoryNoReplace:async(from,to)=>{await assert.rejects(stat(to));await rename(from,to);}});
 const entry=await lib.publish(root,job);
 assert.equal(entry.ready,true);assert.equal(entry.name,'Портрет');
 assert.equal(await readFile(path.join(root,'data/avatars',id,'source/input.mp4'),'utf8'),'source');
 await assert.rejects(lib.publish(root,job));
 assert.equal((await lib.get(root,id)).name,'Портрет');
});
test('preview limits do not break a ready avatar',async t=>{
 const root=await fixture(t);await avatar(root,'a');
 const entries=await createAvatarLibrary({makeThumbnail:async()=> 'data:image/jpeg;base64,'+'a'.repeat(600000)}).list(root);
 assert.equal(entries[0].ready,true);assert.equal(entries[0].thumbnail,null);
});
test('thumbnail decoding receives a bounded file and the selected interpreter outside main',async t=>{
 const root=await fixture(t),dir=await avatar(root,'a');let context;
 const entries=await createAvatarLibrary({readThumbnailBytes:false,makeThumbnail:async(bytes,options)=>{assert.equal(bytes,null);context=options;return null;}}).list(root,{python:'/usr/bin/python3'});
 assert.equal(entries[0].ready,true);assert.deepEqual(context,{root,python:'/usr/bin/python3',sourceFile:path.join(dir,'full_imgs/2.png')});
});

async function referenceAvatar(root,id,model) {
 const dir=path.join(root,'data/avatars',id);await mkdir(path.join(dir,'full_imgs'),{recursive:true});
 await writeFile(path.join(dir,'full_imgs/00000000.png'),'image');
 await writeFile(path.join(dir,'generative-avatar.json'),JSON.stringify({version:1,model}));return dir;
}
test('reference avatars identify their engine and preserve it when renamed',async t=>{
 const root=await fixture(t),lib=createAvatarLibrary();
 for(const model of ['ditto','soulx']) {
  await referenceAvatar(root,model,model);
  const entry=await lib.get(root,model);assert.equal(entry.ready,true,entry.reason);assert.equal(entry.model,model);assert.equal(entry.frameCount,1);
  const renamed=await lib.rename(root,model,'Reference');assert.equal(renamed.model,model);assert.equal(renamed.ready,true);
 }
});
test('reference markers reject incompatible metadata, legacy artifacts, versions and symlinks',async t=>{
 const root=await fixture(t);
 for(const [id,edit] of [
  ['metadata',async dir=>writeFile(path.join(dir,'studio-avatar.json'),JSON.stringify({schemaVersion:1,avatarId:'metadata',model:'soulx',origin:'existing',frameCount:1,name:'A'}))],
  ['coords',async dir=>writeFile(path.join(dir,'coords.pkl'),'legacy')],
  ['version',async dir=>writeFile(path.join(dir,'generative-avatar.json'),JSON.stringify({version:2,model:'ditto'}))],
  ['link',async dir=>{await rm(path.join(dir,'generative-avatar.json'));await symlink(path.join(root,'outside.json'),path.join(dir,'generative-avatar.json'));}],
  ['extra',async dir=>writeFile(path.join(dir,'full_imgs/00000001.png'),'image')],
 ]){const dir=await referenceAvatar(root,id,'ditto');await edit(dir);}
 await writeFile(path.join(root,'outside.json'),JSON.stringify({version:1,model:'ditto'}));
 for(const entry of await createAvatarLibrary().list(root))assert.equal(entry.ready,false,entry.id);
});

test('publishing reference avatars preserves source, marker and selected engine',async t=>{
 for(const model of ['ditto','soulx']) {
  const root=await fixture(t),jobId='a'.repeat(32),id='studio_'+'b'.repeat(32),jobDir=path.join(root,'data/.studio-avatar-work',jobId);
  const staged=await referenceAvatar(root,'staged',model);
  await mkdir(path.join(jobDir,'output'),{recursive:true});await rename(staged,path.join(jobDir,'output',id));
  await mkdir(path.join(jobDir,'source'));await writeFile(path.join(jobDir,'source/input.png'),'original');
  const library=createAvatarLibrary({moveDirectoryNoReplace:rename});
  const entry=await library.publish(root,{jobId,jobDir,avatarId:id,model,name:'Reference',frameCount:1,parameters:{}});
  assert.equal(entry.ready,true,entry.reason);assert.equal(entry.model,model);
  const final=path.join(root,'data/avatars',id);
  assert.equal(await readFile(path.join(final,'source/input.png'),'utf8'),'original');
  assert.deepEqual(JSON.parse(await readFile(path.join(final,'generative-avatar.json'),'utf8')),{version:1,model});
 }
});
