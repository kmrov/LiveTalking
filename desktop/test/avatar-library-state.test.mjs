import test from 'node:test';import assert from 'node:assert/strict';
import { filterAvatars,avatarActionState,buildCreationInput } from '../renderer/avatar-library-state.mjs';
test('search uses display names and technical IDs without case sensitivity',()=>{
 const entries=[{id:'portrait',name:'Батя',ready:true},{id:'other',name:'Другой',ready:false}];
 assert.deepEqual(filterAvatars(entries,'БАТЯ').map(x=>x.id),['portrait']);assert.deepEqual(filterAvatars(entries,'PORTRAIT').map(x=>x.id),['portrait']);
});
test('recording blocks a destructive session change and keeps the explicit label',()=>{
 const action=avatarActionState({serviceActive:true,recording:true,recordingBusy:false,generationBusy:false},null);
 assert.equal(action.canCreate,false);assert.equal(action.canSelect,false);assert.equal(action.selectLabel,'Остановить и выбрать');
});
test('running preparation blocks starts and environment changes but permits cancellation',()=>{
 const action=avatarActionState({serviceActive:false,recording:false,recordingBusy:false},{state:'running'});
 assert.equal(action.canCreate,false);assert.equal(action.canStart,false);assert.equal(action.canChangeEnvironment,false);assert.equal(action.canCancel,true);
 assert.equal(avatarActionState({}, {state:'publishing'}).canCancel,false);
 assert.equal(avatarActionState({}, {state:'interrupted'}).canRetry,true);
});
test('creation takes trusted selection and profile fields, and excludes form path overrides',()=>{
 const profile={liveTalking:{root:'/checkout',python:'/checkout/.venv/bin/python'}},selection={token:'selected',kind:'image'};
 const value=buildCreationInput(profile,selection,{name:'Лицо',model:'musetalk',parameters:{},sourceToken:'fake',root:'/other',sourceFile:'/etc/passwd'});
 assert.equal(value.root,'/checkout');assert.equal(value.sourceToken,'selected');assert.equal(Object.hasOwn(value,'sourceFile'),false);
 assert.throws(()=>buildCreationInput(profile,selection,{name:'Лицо',model:'wav2lip',parameters:{}}));
});
