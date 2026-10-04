import { filterAvatars,avatarActionState,buildCreationInput,avatarSnapshotBelongsToRoot } from './avatar-library-state.mjs';
const models={musetalk:'MuseTalk',wav2lip:'Wav2Lip',ultralight:'Ultralight',ditto:'Ditto · experimental',soulx:'SoulX FlashHead Lite · experimental'};
const stages={checking:'Checking environment',copying:'Saving source',downloading:'Downloading models',normalizing:'Preparing photo or video',generating:'Creating avatar',validating:'Checking result',publishing:'Saving avatar'};
export function mountAvatarLibrary({document,bridge,getProfile,onProfileSelected,prepareSessionChange,getSessionState}) {
 const $=selector=>document.querySelector(selector),cleanups=[];
 let entries=[],job=null,selection=null,pending=false,refreshGeneration=0,disposed=false,catalog=null;
 const listen=(element,type,handler)=>{element.addEventListener(type,handler);cleanups.push(()=>element.removeEventListener(type,handler));};
 const action=()=>avatarActionState(getSessionState(),job);
 function show(dialog){if(!dialog.open){dialog.opener=document.activeElement;dialog.showModal();}}
 for(const dialog of [$('#avatar-library-dialog'),$('#avatar-create-dialog')])listen(dialog,'close',()=>{
  const opener=dialog.opener;
  (opener&&!opener.disabled?opener:!$('#open-avatar-job').hidden?$('#open-avatar-job'):$('#open-avatar-library')).focus();
 });
 for(const dialog of [$('#avatar-library-dialog'),$('#avatar-create-dialog')])listen(dialog,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();dialog.close();}});
 document.querySelectorAll('[data-close-avatar]').forEach(button=>listen(button,'click',()=>$('#'+button.dataset.closeAvatar).close()));
 async function perform(operation,target='#avatar-create-message') {
  if(pending)return;pending=true;$(target).textContent='';renderControls();
  try{return await operation();}catch(error){$(target).textContent=error.message;}finally{pending=false;renderControls();}
 }
 function form(){const model=$('#new-avatar-model').value;return{name:$('#new-avatar-name').value,model,parameters:model==='musetalk'?{bbox_shift:Number($('#new-avatar-bbox').value),extra_margin:Number($('#new-avatar-margin').value),parsing_mode:$('#new-avatar-parsing').value}:model==='wav2lip'?{pads:$('#new-avatar-pads').value.trim().split(/\s+/).map(Number),face_det_batch_size:Number($('#new-avatar-batch').value),nosmooth:$('#new-avatar-nosmooth').checked}:{}};}
 function modelOptions(){const model=$('#new-avatar-model').value;$('#musetalk-avatar-options').hidden=model!=='musetalk';$('#wav2lip-avatar-options').hidden=model!=='wav2lip';$('#avatar-preparation-options').hidden=['ditto','soulx'].includes(model);const hint=$('#generative-avatar-hint');hint.hidden=!['ditto','soulx'].includes(model);hint.textContent=model==='ditto'?'Experimental · Speech is prepared before playback. Longer replies take more time to start.':'Experimental · Animates the face from a photo while speech plays.';}
 function renderCurrent(){
  const selected=entries.find(entry=>entry.id===getProfile()?.liveTalking.avatarId);
  $('#selected-avatar-name').textContent=selected?.name||'Select an avatar';$('#selected-avatar-model').textContent=selected?models[selected.model]||selected.reason:'';
  const image=$('#selected-avatar-image');image.hidden=!selected?.thumbnail;if(selected?.thumbnail)image.src=selected.thumbnail;else image.removeAttribute('src');
 }
 async function select(id,target='#avatar-library-message') {
  await perform(async()=>{
   if(!action().canSelect)throw new Error('Finish recording or preparation before selecting an avatar.');
   await prepareSessionChange();
   const profile=await bridge.selectAvatar(getProfile(),id,{stopServices:true});onProfileSelected(profile);
   $('#avatar-library-dialog').close();$('#avatar-create-dialog').close();await refresh();
  },target);
 }
 function renderCards(){
  const container=$('#avatar-cards');container.replaceChildren();
  const filtered=filterAvatars(entries,$('#avatar-search').value);
  if(!filtered.length){const empty=document.createElement('p');empty.textContent=entries.length?'No results found.':'No avatars yet. Create one from a photo or video.';container.append(empty);}
  for(const entry of filtered){
   const card=document.createElement('article');card.className='avatar-card';card.dataset.avatarId=entry.id;
   const thumbnail=document.createElement('div');thumbnail.className='avatar-card-image';
   if(entry.thumbnail){const image=document.createElement('img');image.src=entry.thumbnail;image.alt='';image.loading='lazy';thumbnail.append(image);}else thumbnail.textContent='◇';
   const name=document.createElement('h3');name.dataset.avatarName='';name.textContent=entry.name;
   const model=document.createElement('p');model.textContent=models[entry.model]||'Unknown model';
   card.append(thumbnail,name,model);
   const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Details';details.append(summary);
   const id=document.createElement('small');id.textContent=entry.id;details.append(id);card.append(details);
   if(!entry.ready){const error=document.createElement('p');error.className='avatar-error';error.textContent=entry.reason;card.append(error);}
   const choose=document.createElement('button');choose.type='button';choose.dataset.avatarSelect=entry.id;choose.dataset.ready=String(entry.ready);choose.textContent=action().selectLabel;choose.disabled=!entry.ready||!action().canSelect||pending;choose.addEventListener('click',()=>void select(entry.id));card.append(choose);
   if(entry.ready){const rename=document.createElement('details'),label=document.createElement('summary');label.textContent='Rename';rename.append(label);const input=document.createElement('input');input.value=entry.name;input.maxLength=120;input.setAttribute('aria-label','New avatar name');const save=document.createElement('button');save.type='button';save.textContent='Save name';save.addEventListener('click',()=>void perform(async()=>{await bridge.renameAvatar({root:getProfile().liveTalking.root,id:entry.id,name:input.value});await refresh();},'#avatar-library-message'));rename.append(input,save);card.append(rename);}
   container.append(card);
  }
 }
 function renderJob(){
  $('#avatar-job-panel').hidden=!job;$('#open-avatar-job').hidden=!job;
  if(!job)return;
  const labels={completed:'Avatar ready',failed:'Could not create avatar',cancelled:'Preparation cancelled',interrupted:'Preparation interrupted when the app closed',cancelling:'Cancelling preparation'};
  const label=labels[job.state]||stages[job.stage]||'Preparing';
  $('#avatar-job-state').textContent=`${job.name}: ${label}`;$('#avatar-job-state').dataset.avatarStage=job.state;
  $('#avatar-job-progress').value=job.progress||0;$('#avatar-job-error').textContent=job.errorMessage||'';
  $('#avatar-job-message').textContent=['checking','running','publishing'].includes(job.state)?job.message||'':'';
  $('#avatar-job-log').textContent=job.logPath?`Log: ${job.logPath}`:'';
  $('#avatar-summary-message').textContent=label;
 }
 function renderControls(){
  const value=action(),session=getSessionState();
  for(const control of document.querySelectorAll('[data-avatar-select]')){control.disabled=control.dataset.ready!=='true'||!value.canSelect||pending;control.textContent=value.selectLabel;}
  for(const id of ['open-avatar-create','library-create-avatar','choose-avatar-source'])$('#'+id).disabled=!value.canCreate||pending;
  $('#submit-avatar-create').disabled=!value.canCreate||pending||!selection;$('#submit-avatar-create').textContent=value.createLabel;
  $('#check-avatar-create').disabled=!value.canCreate||pending||!selection;
  $('#cancel-avatar-job').disabled=!value.canCancel||pending;$('#cancel-avatar-job').hidden=!value.canCancel;
  $('#retry-avatar-job').hidden=!value.canRetry;$('#retry-avatar-job').disabled=pending;$('#select-created-avatar').hidden=job?.state!=='completed';$('#select-created-avatar').disabled=!value.canSelect||pending;
  $('#select-created-avatar').textContent=value.selectLabel;
  $('#start-profile').disabled=!value.canStart||['checking','starting','ready'].includes(session.servicePhase);
  $('#choose-root').disabled=!value.canChangeEnvironment||pending;$('#python-path').disabled=!value.canChangeEnvironment||pending;
  for(const control of $('#avatar-create-form').querySelectorAll('input,select'))control.disabled=!value.canCreate||pending;
 }
 function applySnapshot(snapshot={}) {
  if(disposed)return;
  if(snapshot.entries)catalog={root:snapshot.root,profileRoot:getProfile()?.liveTalking.root};
  if(!avatarSnapshotBelongsToRoot(snapshot,getProfile()?.liveTalking.root,catalog))return;
  const previous=job;
  if(snapshot.entries)entries=snapshot.entries;if(Object.hasOwn(snapshot,'job'))job=snapshot.job;
  renderCurrent();renderJob();renderControls();
  if(Object.hasOwn(snapshot,'error'))$('#avatar-summary-message').textContent=snapshot.error||(!job?'':$('#avatar-summary-message').textContent);
  if(snapshot.entries||previous?.state!==job?.state)renderCards();
  if(job?.state==='completed' && (previous?.state!=='completed'||previous?.jobId!==job.jobId))void refresh();
 }
 async function refresh(){
  if(disposed||!getProfile())return;
  const token=++refreshGeneration,root=getProfile().liveTalking.root;
  const snapshot=await bridge.avatarSnapshot(getProfile());
  if(token===refreshGeneration&&!disposed&&root===getProfile().liveTalking.root)applySnapshot(snapshot);
 }
 const openCreate=()=>{$('#avatar-library-dialog').close();show($('#avatar-create-dialog'));renderControls();};
 listen($('#open-avatar-library'),'click',()=>{show($('#avatar-library-dialog'));void perform(refresh,'#avatar-library-message');});
 for(const id of ['open-avatar-create','library-create-avatar','open-avatar-job'])listen($('#'+id),'click',openCreate);
 listen($('#refresh-avatar-library'),'click',()=>void perform(refresh,'#avatar-library-message'));
 listen($('#avatar-search'),'input',renderCards);listen($('#new-avatar-model'),'change',modelOptions);
 listen($('#choose-avatar-source'),'click',()=>void perform(async()=>{
  const value=await bridge.chooseAvatarSource(getProfile());if(!value)return;selection=value;
  $('#avatar-source-name').textContent=value.fileName;$('#new-avatar-name').value=value.fileName.replace(/\.[^.]+$/,'').slice(0,120);
  const image=$('#avatar-source-preview');image.hidden=!value.preview;if(value.preview)image.src=value.preview;else image.removeAttribute('src');
  const modelSelect=$('#new-avatar-model');
  for(const option of modelSelect.options)option.disabled=(option.value==='wav2lip' && value.kind==='image')||(['ditto','soulx'].includes(option.value) && value.kind==='video');
  if(modelSelect.selectedOptions[0]?.disabled)modelSelect.value='musetalk';
  modelOptions();$('#avatar-create-checks').replaceChildren();
 }));
 listen($('#check-avatar-create'),'click',()=>void perform(async()=>{
  const checks=await bridge.checkAvatarCreation(buildCreationInput(getProfile(),selection,form()));const list=$('#avatar-create-checks');list.replaceChildren();
  for(const check of checks){const row=document.createElement('li');row.dataset.state=check.state;row.textContent=`${check.state==='ready'?'✓':'○'} ${check.detail}${check.action?' — '+check.action:''}`;list.append(row);}
 }));
 listen($('#avatar-create-form'),'submit',event=>{event.preventDefault();void perform(async()=>{
  if(!action().canCreate)throw new Error('Finish recording or preparation first.');
  const input=buildCreationInput(getProfile(),selection,form());await prepareSessionChange();
  applySnapshot({job:await bridge.createAvatar(input,{stopServices:true})});
 });});
 listen($('#cancel-avatar-job'),'click',()=>void perform(async()=>applySnapshot({job:await bridge.cancelAvatar(job.jobId)})));
 listen($('#retry-avatar-job'),'click',()=>void perform(async()=>{
  await prepareSessionChange();const profile=getProfile();applySnapshot({job:await bridge.retryAvatar({root:profile.liveTalking.root,python:profile.liveTalking.python,jobId:job.jobId},{stopServices:true})});
 }));
 listen($('#select-created-avatar'),'click',()=>void select(job.avatarId,'#avatar-create-message'));
 cleanups.push(bridge.onAvatarSnapshot(applySnapshot));
 return {refresh,applySnapshot,dispose:()=>{disposed=true;refreshGeneration++;cleanups.splice(0).forEach(cleanup=>cleanup());}};
}
