import { normalizeAvatarCreation } from '../src/avatar-contract.mjs';
export function filterAvatars(entries,query) {
 const value=query.trim().toLocaleLowerCase('ru');return entries.filter(entry=>`${entry.name} ${entry.id}`.toLocaleLowerCase('ru').includes(value));
}
export function avatarActionState(session={},job) {
 const busy=Boolean(session.generationBusy)||['checking','running','cancelling','publishing'].includes(job?.state);
 const recording=Boolean(session.recording||session.recordingBusy);
 return {canCreate:!busy&&!recording,canSelect:!busy&&!recording,canStart:!busy,canChangeEnvironment:!busy,canCancel:busy&&!['publishing','cancelling'].includes(job?.state),canRetry:!busy&&!recording&&['failed','cancelled','interrupted'].includes(job?.state),createLabel:session.serviceActive?'Остановить и создать':'Создать',selectLabel:session.serviceActive?'Остановить и выбрать':'Выбрать'};
}
export function buildCreationInput(profile,selection,form) {
 if(!selection)throw new Error('Сначала выберите фото или видео.');
 const value=normalizeAvatarCreation({name:form.name,model:form.model,kind:selection.kind,parameters:form.parameters});
 return {root:profile.liveTalking.root,python:profile.liveTalking.python,sourceToken:selection.token,name:value.name,model:value.model,parameters:value.parameters};
}
