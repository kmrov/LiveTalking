import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaKind, normalizeAvatarName, normalizeAvatarCreation } from '../src/avatar-contract.mjs';

test('creation defaults preserve Russian names and separate photo models', () => {
  assert.equal(mediaKind('Фото.JPG'), 'image');
  assert.equal(mediaKind('clip.MOV'), 'video');
  assert.throws(() => mediaKind('file.exe'));
  const input = normalizeAvatarCreation({ name: ' Мой аватар ', model: 'musetalk', kind: 'image', parameters: {} });
  assert.equal(input.name, 'Мой аватар');
  assert.deepEqual(input.parameters, { bbox_shift: 0, extra_margin: 10, parsing_mode: 'jaw' });
  assert.throws(() => normalizeAvatarCreation({ ...input, model: 'wav2lip' }));
  assert.deepEqual(normalizeAvatarCreation({name:'Видео',model:'wav2lip',kind:'video'}).parameters, {pads:[0,10,0,0],nosmooth:false,face_det_batch_size:16});
});

test('invalid names and out-of-range or unknown parameters are rejected', () => {
  for (const name of ['', ' '.repeat(3), 'x'.repeat(121), 'a\0b', 'a\nb']) assert.throws(() => normalizeAvatarName(name));
  assert.equal(normalizeAvatarName('я'.repeat(120)).length, 120);
  const base = {name:'A',model:'musetalk',kind:'image'};
  for (const parameters of [{bbox_shift:51},{bbox_shift:-51},{bbox_shift:0.5},{extra_margin:-1},{extra_margin:101},{parsing_mode:'bad'},{shell:'x'}]) assert.throws(()=>normalizeAvatarCreation({...base,parameters}));
  assert.equal(normalizeAvatarCreation({...base,parameters:{bbox_shift:-50,extra_margin:100,parsing_mode:'neck'}}).parameters.bbox_shift,-50);
  for (const parameters of [{pads:[0,0,0]},{pads:[0,0,0,201]},{nosmooth:'false'},{face_det_batch_size:0},{face_det_batch_size:129}]) assert.throws(()=>normalizeAvatarCreation({...base,model:'wav2lip',kind:'video',parameters}));
});

test('generative engines accept image references without face detector parameters', () => {
 for (const model of ['ditto','soulx','avtr1']) {
  assert.deepEqual(normalizeAvatarCreation({name:'Reference',model,kind:'image'}).parameters,{});
  assert.throws(()=>normalizeAvatarCreation({name:'Reference',model,kind:'video'}),/photo|image/i);
  assert.throws(()=>normalizeAvatarCreation({name:'Reference',model,kind:'image',parameters:{pads:[0,0,0,0]}}));
 }
});
