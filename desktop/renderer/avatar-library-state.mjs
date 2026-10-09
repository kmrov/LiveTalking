import { normalizeAvatarCreation } from '../src/avatar-contract.mjs';
export function avatarSnapshotBelongsToRoot(snapshot,profileRoot,catalog) {
 return !snapshot.root || snapshot.root===profileRoot || (catalog?.profileRoot===profileRoot && snapshot.root===catalog.root);
}
export function filterAvatars(entries,query) {
 const value=query.trim().toLocaleLowerCase('ru');return entries.filter(entry=>`${entry.name} ${entry.id}`.toLocaleLowerCase('ru').includes(value));
}
export function preferredAvatarModel({selectedModel,userSelected=false,lastModel,currentModel,kind,availableModels}={}) {
 const models=availableModels||['musetalk','wav2lip','ditto','soulx'];
 const compatible=model=>models.includes(model)
  && (availableModels || ((kind!=='image'||model!=='wav2lip') && (kind!=='video'||!['ditto','soulx'].includes(model))));
 return [userSelected?selectedModel:null,lastModel,currentModel,'musetalk',...models].find(compatible)||'';
}
export function avatarJobDisplay(job) {
 if(!job)return {showProgressLink:false,showJob:false,inHistory:false};
 return {showProgressLink:job.state!=='completed',showJob:true,inHistory:job.state==='completed'};
}
export function avatarActionState(session={},job) {
 const busy=Boolean(session.generationBusy)||['checking','running','cancelling','publishing'].includes(job?.state);
 const recording=Boolean(session.recording||session.recordingBusy);
 return {canCreate:!busy&&!recording,canSelect:!busy&&!recording,canStart:!busy,canChangeEnvironment:!busy,canCancel:busy&&!['publishing','cancelling'].includes(job?.state),canRetry:!busy&&!recording&&['failed','cancelled','interrupted'].includes(job?.state),createLabel:session.serviceActive?'Stop and create':'Create',selectLabel:session.serviceActive?'Stop and select':'Select'};
}
export function buildCreationInput(profile,selection,form) {
 if(!selection)throw new Error('Select a photo or video first.');
 const value=normalizeAvatarCreation({name:form.name,model:form.model,kind:selection.kind,parameters:form.parameters});
 return {root:profile.liveTalking.root,python:profile.liveTalking.python,sourceToken:selection.token,name:value.name,model:value.model,parameters:value.parameters};
}
