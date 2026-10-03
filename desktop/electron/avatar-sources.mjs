import path from 'node:path';
import { lstat, realpath as nodeRealpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mediaKind } from '../src/avatar-contract.mjs';
import { runAvatarCommand } from './avatar-prerequisites.mjs';

export function createAvatarSources({chooseFile,inspectPreview=input=>runAvatarCommand(input,'preview'),stat=file=>lstat(file,{bigint:true}),realpath=nodeRealpath,now=Date.now,uuid=randomUUID}={}) {
  const selections=new Map();
  const fingerprint=value=>[value.dev,value.ino,value.size,value.mtimeNs??value.mtimeMs].map(String).join(':');
  async function choose(profile) {
    const chosen=await chooseFile(profile);if(!chosen)return null;
    const root=await realpath(profile.liveTalking.root),file=await realpath(chosen),kind=mediaKind(chosen),info=await stat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size==0)throw new Error('Select a nonempty source file.');
    const token=uuid();selections.set(token,{root,file,kind,fingerprint:fingerprint(info),createdAt:now()});
    while(selections.size>32)selections.delete(selections.keys().next().value);
    let preview=null;
    try {
      const image=await inspectPreview({root,python:profile.liveTalking.python,sourceFile:file,sourceKind:kind});
      if(typeof image==='string'&&/^data:image\/(jpeg|png);base64,/.test(image)&&image.length<=512*1024)preview=image;
    }catch { /* Actual decoding prerequisites appear in the creation checks. */ }
    return {token,fileName:path.basename(chosen),kind,preview};
  }
  async function resolve(token,root) {
    const selection=selections.get(token);
    if(!selection||selection.root!==await realpath(root))throw new Error('Select the source again for this folder.');
    let info;try{info=await stat(selection.file);}catch{throw new Error('Source was deleted: select the file again.');}
    if(!info.isFile()||info.isSymbolicLink()||fingerprint(info)!==selection.fingerprint)throw new Error('Source changed: select the file again.');
    return {sourceFile:selection.file,sourceKind:selection.kind,sourceFingerprint:selection.fingerprint};
  }
  return {choose,resolve,forgetAll:()=>selections.clear()};
}
