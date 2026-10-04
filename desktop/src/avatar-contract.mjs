export function normalizeAvatarName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) || !value.trim() || [...value.trim()].length > 120) throw new Error('Name must contain 1 to 120 characters without control characters.');
  return value.trim();
}
export function mediaKind(fileName) {
  const extension = String(fileName).match(/\.[^./\\]+$/)?.[0].toLowerCase() || '';
  if (['.png','.jpg','.jpeg'].includes(extension)) return 'image';
  if (['.mp4','.mov','.mkv','.avi'].includes(extension)) return 'video';
  throw new Error('Select a PNG/JPEG image or MP4/MOV/MKV/AVI video.');
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}: must be an integer from ${min} to ${max}.`);
  return value;
}
export function normalizeAvatarCreation({ name, model, kind, parameters = {} }) {
  name = normalizeAvatarName(name);
  const generative = ['ditto','soulx'].includes(model);
  if (!['image','video'].includes(kind) || !['musetalk','wav2lip','ditto','soulx'].includes(model) || (kind === 'image' && model === 'wav2lip') || (kind === 'video' && generative)) throw new Error('Choose MuseTalk, Ditto or SoulX for a photo; MuseTalk or Wav2Lip for a video.');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Invalid preparation parameters.');
  const defaults = generative ? {} : model === 'musetalk' ? {bbox_shift:0,extra_margin:10,parsing_mode:'jaw'} : {pads:[0,10,0,0],nosmooth:false,face_det_batch_size:16};
  if (Object.keys(parameters).some(key => !Object.hasOwn(defaults,key))) throw new Error('Unknown preparation parameter.');
  const result = {...defaults,...parameters};
  if (model === 'musetalk') {
    integer(result.bbox_shift,'Face offset',-50,50); integer(result.extra_margin,'Margin',0,100);
    if (!['jaw','neck','raw'].includes(result.parsing_mode)) throw new Error('Unsupported face mask mode.');
  } else if (model === 'wav2lip') {
    if (!Array.isArray(result.pads) || result.pads.length !== 4) throw new Error('Four padding values are required: top, bottom, left, right.');
    result.pads = result.pads.map(value => integer(value,'Margin',0,200));
    if (typeof result.nosmooth !== 'boolean') throw new Error('nosmooth must be a boolean.');
    integer(result.face_det_batch_size,'Batch size',1,128);
  }
  return {name,model,kind,parameters:result};
}
export function validateAvatarId(id) {
  if (typeof id !== 'string' || !/^[\p{L}\p{N}_-]{1,128}$/u.test(id)) throw new Error('Invalid avatar ID.');
  return id;
}
