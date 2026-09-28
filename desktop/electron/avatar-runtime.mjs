import { normalizeProfile } from '../src/profile.mjs';
import { normalizeAvatarCreation } from '../src/avatar-contract.mjs';

export function createAvatarRuntime({library,jobs,sources,profiles,stopProfile,getServiceState,inspectCreation}={}) {
  let queue=Promise.resolve();
  function runLifecycle(operation) {const result=queue.then(operation);queue=result.catch(()=>{});return result;}
  function ensureIdle() {if(jobs.isBusy())throw new Error('Сначала завершите или отмените подготовку аватара.');}
  const active=()=>['checking','starting','ready','reconnecting','failed'].includes(getServiceState().phase);
  async function stopIfNeeded(options={}) {
    if(!active())return;
    if(options.stopServices!==true)throw new Error('Остановите профиль перед созданием или выбором аватара.');
    await stopProfile();
  }
  async function creation(input) {
    if(!input||typeof input.root!=='string'||typeof input.python!=='string')throw new Error('Выберите каталог и Python LiveTalking.');
    const resolved=await sources.resolve(input.sourceToken,input.root);
    const normalized=normalizeAvatarCreation({name:input.name,model:input.model,kind:resolved.sourceKind,parameters:input.parameters});
    return {root:input.root,python:input.python,...resolved,name:normalized.name,model:normalized.model,parameters:normalized.parameters};
  }
  async function assertCanSave(profile) {
    ensureIdle();profile=normalizeProfile(profile);
    if(active()) {
      const state=getServiceState(),old=profiles.get(state.profileId||profile.id);
      if(old && ['root','python','model','avatarId','port'].some(key=>old.liveTalking[key]!==profile.liveTalking[key]))throw new Error('Остановите профиль перед изменением аватара или окружения.');
    }
  }
  return {
    runLifecycle,
    list:profile=>library.list(normalizeProfile(profile).liveTalking.root),
    chooseSource:profile=>{ensureIdle();return sources.choose(normalizeProfile(profile));},
    checkCreation:async input=>inspectCreation(await creation(input)),
    create:(input,options)=>runLifecycle(async()=>{ensureIdle();const value=await creation(input);await stopIfNeeded(options);return jobs.start(value);}),
    retry:(input,options)=>runLifecycle(async()=>{ensureIdle();await stopIfNeeded(options);return jobs.retry({root:input.root,python:input.python,jobId:input.jobId});}),
    rename:({root,id,name})=>library.rename(root,id,name),
    select:(input,id,options)=>runLifecycle(async()=>{
      ensureIdle();const profile=normalizeProfile(input),entry=await library.get(profile.liveTalking.root,id);
      if(!entry?.ready)throw new Error(entry?.reason||'Выберите готового аватара из библиотеки.');
      await stopIfNeeded(options);
      return profiles.save({...profile,liveTalking:{...profile.liveTalking,model:entry.model,avatarId:entry.id}});
    }),
    assertCanStart:async profile=>{ensureIdle();const entry=await library.get(profile.liveTalking.root,profile.liveTalking.avatarId);if(!entry?.ready||entry.model!==profile.liveTalking.model)throw new Error(entry?.reason||'Выберите готового аватара нужной модели.');},
    assertCanSave,
    shutdown:()=>jobs.shutdown(),
    snapshot:async profile=>({entries:await library.list(profile.liveTalking.root),job:await jobs.snapshot(profile.liveTalking.root)}),
  };
}
