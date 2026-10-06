import { normalizeProfile } from '../src/profile.mjs';
import { normalizeAvatarCreation } from '../src/avatar-contract.mjs';
import { avatarRoot } from './avatar-library.mjs';

export function createAvatarRuntime({library,jobs,sources,profiles,stopProfile,getServiceState,inspectCreation}={}) {
  let queue=Promise.resolve();
  const recovery=new Map();
  async function snapshot(input) {
    const profile=normalizeProfile(input),lt=profile.liveTalking;
    try {
      if(!lt.root)return {root:null,entries:[],job:null,error:''};
      const root=(await avatarRoot(lt.root)).root;
      if(!recovery.has(root)) {
        const result=Promise.resolve().then(()=>jobs.recover(root));
        recovery.set(root,result);result.catch(()=>recovery.delete(root));
      }
      await recovery.get(root);
      return {root,entries:await library.list(root,{python:lt.python}),job:await jobs.snapshot(root),error:''};
    } catch(error) {return {root:null,entries:[],job:null,error:`Could not open library: ${error.message}`};}
  }
  function runLifecycle(operation) {const result=queue.then(operation);queue=result.catch(()=>{});return result;}
  function ensureIdle() {if(jobs.isBusy())throw new Error('Finish or cancel avatar preparation first.');}
  const active=()=>['checking','starting','ready','reconnecting','failed'].includes(getServiceState().phase);
  async function stopIfNeeded(options={}) {
    if(!active())return;
    if(options.stopServices!==true)throw new Error('Stop the profile before creating or selecting an avatar.');
    await stopProfile();
  }
  async function creation(input) {
    if(!input||typeof input.root!=='string'||typeof input.python!=='string')throw new Error('Select the LiveTalking folder and Python executable.');
    const resolved=await sources.resolve(input.sourceToken,input.root);
    const normalized=normalizeAvatarCreation({name:input.name,model:input.model,kind:resolved.sourceKind,parameters:input.parameters});
    return {root:input.root,python:input.python,...resolved,name:normalized.name,model:normalized.model,parameters:normalized.parameters};
  }
  async function assertCanSave(profile) {
    ensureIdle();profile=normalizeProfile(profile);
    if(active()) {
      const state=getServiceState(),old=profiles.get(state.profileId||profile.id);
      if(old && ['root','python','model','avatarId','port'].some(key=>old.liveTalking[key]!==profile.liveTalking[key]))throw new Error('Stop the profile before changing the avatar or environment.');
    }
  }
  async function save(input) {
    ensureIdle();
    const profile = normalizeProfile(input);
    if (active()) {
      const state = getServiceState();
      const old = profiles.get(state.profileId || profile.id);
      if (old && ['root', 'python', 'model', 'avatarId', 'port'].some(key => old.liveTalking[key] !== profile.liveTalking[key])) {
        await stopProfile();
      }
    }
    return profiles.save(profile);
  }
  return {
    runLifecycle,
    list:input=>{const profile=normalizeProfile(input);return library.list(profile.liveTalking.root,{python:profile.liveTalking.python});},
    chooseSource:profile=>{ensureIdle();return sources.choose(normalizeProfile(profile));},
    checkCreation:async input=>inspectCreation(await creation(input)),
    create:(input,options)=>runLifecycle(async()=>{ensureIdle();await creation(input);await stopIfNeeded(options);return jobs.start(await creation(input));}),
    retry:(input,options)=>runLifecycle(async()=>{ensureIdle();await stopIfNeeded(options);return jobs.retry({root:input.root,python:input.python,jobId:input.jobId});}),
    rename:({root,id,name})=>library.rename(root,id,name),
    select:(input,id,options)=>runLifecycle(async()=>{
      ensureIdle();const profile=normalizeProfile(input),entry=await library.get(profile.liveTalking.root,id);
      if(!entry?.ready)throw new Error(entry?.reason||'Select a ready avatar from the library.');
      await stopIfNeeded(options);
      return profiles.save({...profile,liveTalking:{...profile.liveTalking,model:entry.model,avatarId:entry.id}});
    }),
    assertCanStart:async profile=>{ensureIdle();const entry=await library.get(profile.liveTalking.root,profile.liveTalking.avatarId);if(!entry?.ready||entry.model!==profile.liveTalking.model)throw new Error(entry?.reason||'Select a ready avatar for the chosen model.');},
    assertCanSave,
    save,
    shutdown:()=>jobs.shutdown(),
    snapshot,
  };
}
