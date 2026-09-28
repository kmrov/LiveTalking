export function normalizeAvatarName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) || !value.trim() || [...value.trim()].length > 120) throw new Error('Название должно содержать от 1 до 120 символов без управляющих символов.');
  return value.trim();
}
export function mediaKind(fileName) {
  const extension = String(fileName).match(/\.[^./\\]+$/)?.[0].toLowerCase() || '';
  if (['.png','.jpg','.jpeg'].includes(extension)) return 'image';
  if (['.mp4','.mov','.mkv','.avi'].includes(extension)) return 'video';
  throw new Error('Выберите PNG/JPEG или видео MP4/MOV/MKV/AVI.');
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}: нужно целое число от ${min} до ${max}.`);
  return value;
}
export function normalizeAvatarCreation({ name, model, kind, parameters = {} }) {
  name = normalizeAvatarName(name);
  if (!['image','video'].includes(kind) || !['musetalk','wav2lip'].includes(model) || (kind === 'image' && model !== 'musetalk')) throw new Error('Для фото выберите MuseTalk; для видео — MuseTalk или Wav2Lip.');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Некорректные параметры подготовки.');
  const defaults = model === 'musetalk' ? {bbox_shift:0,extra_margin:10,parsing_mode:'jaw'} : {pads:[0,10,0,0],nosmooth:false,face_det_batch_size:16};
  if (Object.keys(parameters).some(key => !Object.hasOwn(defaults,key))) throw new Error('Неизвестный параметр подготовки.');
  const result = {...defaults,...parameters};
  if (model === 'musetalk') {
    integer(result.bbox_shift,'Сдвиг лица',-50,50); integer(result.extra_margin,'Отступ',0,100);
    if (!['jaw','neck','raw'].includes(result.parsing_mode)) throw new Error('Неподдерживаемый режим маски лица.');
  } else {
    if (!Array.isArray(result.pads) || result.pads.length !== 4) throw new Error('Нужны четыре отступа: верх, низ, лево, право.');
    result.pads = result.pads.map(value => integer(value,'Отступ',0,200));
    if (typeof result.nosmooth !== 'boolean') throw new Error('nosmooth должен быть boolean.');
    integer(result.face_det_batch_size,'Размер пакета',1,128);
  }
  return {name,model,kind,parameters:result};
}
export function validateAvatarId(id) {
  if (typeof id !== 'string' || !/^[\p{L}\p{N}_-]{1,128}$/u.test(id)) throw new Error('Некорректный ID аватара.');
  return id;
}
