"""Narrow local media preparation protocol used by LiveTalking Studio."""
import argparse
import importlib
import importlib.util
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.desktop_avatar_media import normalize_media, preview_media, safe_path, validate_generated_avatar, publish_directory
from server.desktop_model_download import ensure_creation_models


def normalized_creation(request):
    name = request.get('name')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Name must contain 1 to 120 characters.')
    kind, model = request.get('sourceKind'), request.get('model')
    if kind not in ('image', 'video') or model not in ('musetalk', 'wav2lip') or (kind == 'image' and model != 'musetalk'):
        raise ValueError('Use MuseTalk for a photo; MuseTalk or Wav2Lip for a video.')
    defaults = dict(bbox_shift=0, extra_margin=10, parsing_mode='jaw') if model == 'musetalk' else dict(pads=[0,10,0,0], nosmooth=False, face_det_batch_size=16)
    parameters = request.get('parameters', {})
    if not isinstance(parameters, dict) or set(parameters) - set(defaults):
        raise ValueError('Invalid preparation parameters.')
    parameters = {**defaults, **parameters}
    def number(key, lo, hi):
        value = parameters[key]
        if type(value) is not int or not lo <= value <= hi:
            raise ValueError(f'{key}: must be an integer from {lo} to {hi}.')
    if model == 'musetalk':
        number('bbox_shift', -50, 50); number('extra_margin', 0, 100)
        if parameters['parsing_mode'] not in ('jaw','neck','raw'):
            raise ValueError('Invalid mask mode.')
    else:
        pads = parameters['pads']
        if not isinstance(pads, list) or len(pads) != 4 or any(type(x) is not int or not 0 <= x <= 200 for x in pads):
            raise ValueError('Four integer padding values from 0 to 200 are required.')
        number('face_det_batch_size', 1, 128)
        if type(parameters['nosmooth']) is not bool:
            raise ValueError('nosmooth must be a boolean.')
    return {**request, 'name':name.strip(), 'parameters':parameters}


def validate_request(request):
    request = normalized_creation(request)
    root = Path(request['root']).resolve(strict=True)
    job_id, avatar_id = request.get('jobId',''), request.get('avatarId','')
    if request.get('schemaVersion') != 1 or not re.fullmatch(r'[a-f0-9-]{32,36}',job_id) or not re.fullmatch(r'studio_[a-f0-9]{32}',avatar_id):
        raise ValueError('Invalid job identifiers or version.')
    expected = safe_path(root, 'data', '.studio-avatar-work', job_id)
    if Path(request['jobDir']).absolute() != expected:
        raise ValueError('Working directory does not match the job.')
    source = Path(request['sourceFile'])
    if not source.is_absolute() or source.is_symlink() or not source.is_file() or not source.stat().st_size:
        raise ValueError('Source is missing or changed.')
    valid = ('.png','.jpg','.jpeg') if request['sourceKind']=='image' else ('.mp4','.mov','.mkv','.avi')
    if source.suffix.lower() not in valid:
        raise ValueError('Unsupported source extension.')
    return {**request, 'root':str(root), 'jobDir':str(expected)}


def detector_file(root, model):
    import torch
    package = 'avatars/musetalk/utils/face_detection' if model=='musetalk' else 'avatars/wav2lip/face_detection'
    candidates = [Path(root)/package/'detection/sfd/s3fd.pth', Path(torch.hub.get_dir())/'checkpoints/s3fd-619a316812.pth']
    return next((x for x in candidates if x.is_file() and x.stat().st_size), None)


def inspect_creation(request):
    request = normalized_creation(request)
    root, source = Path(request['root']), Path(request['sourceFile'])
    results = []
    def check(id, ready, detail, action):
        results.append(dict(id=id,state='ready' if ready else 'missing',detail=detail,action='' if ready else action))
    check('source',source.is_file() and source.stat().st_size>0,'Source is available' if source.is_file() else 'Source not found','Select the file again.')
    check('checkout',(root/'app.py').is_file() and (root/'avatars').is_dir(),'LiveTalking folder','Select a compatible LiveTalking checkout.')
    modules=['torch','cv2','PIL','numpy','scipy'] + (['diffusers','transformers','face_recognition'] if request['model']=='musetalk' else [])
    missing = [x for x in modules if importlib.util.find_spec(x) is None]
    check('python',not missing,'Preparation modules: '+(', '.join(missing) if missing else 'available'),'Install LiveTalking dependencies in the selected Python environment.')
    try:
        import torch
        available=torch.cuda.is_available()
        detector=detector_file(root,request['model'])
    except (ImportError,OSError):
        available=False;detector=None
    check('gpu',available,'NVIDIA CUDA is available' if available else 'NVIDIA CUDA is unavailable for the selected Python','Check the NVIDIA driver and CUDA in the LiveTalking environment.')
    weights=['models/sd-vae/config.json','models/sd-vae/diffusion_pytorch_model.bin','models/musetalkV15/musetalk.json','models/musetalkV15/unet.pth','models/face-parse-bisent/resnet18-5c106cde.pth','models/face-parse-bisent/79999_iter.pth'] if request['model']=='musetalk' else []
    absent=[x for x in weights if not (root/x).is_file() or not (root/x).stat().st_size]
    if not detector:absent.append('s3fd.pth (face detector)')
    check('weights',not absent,'Preparation weights found' if not absent else 'Weights to download: '+', '.join(absent),'Press Create: Studio will download missing weights from Hugging Face.')
    if request['sourceKind']=='video':check('ffmpeg',bool(shutil.which('ffmpeg')),'FFmpeg for video','Install FFmpeg or create an avatar from a photo.')
    try:
        target = root/'data'
        while not target.exists():target=target.parent
        free=shutil.disk_usage(target).free
        enough=os.access(target,os.W_OK) and free>source.stat().st_size
        check('disk',enough,f'Free {free//(1024*1024)} MB','Free disk space and check write permissions in data.')
    except OSError as error:check('disk',False,str(error),'Check the file, disk space, and write permissions.')
    return results


def local_generator(model, root):
    import torch
    import torch.utils.model_zoo
    file = detector_file(root,model)
    if not file:raise ValueError('Local face detector weights not found.')
    def local_weights(url, *args, **kwargs):
        if not str(url).endswith('s3fd-619a316812.pth'):
            raise ValueError('Automatic weight download is disabled in Studio.')
        return torch.load(file,map_location='cpu',weights_only=True)
    torch.utils.model_zoo.load_url = local_weights
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    return importlib.import_module(f'avatars.{model}.genavatar').generate_avatar


def run_job(request, emit, generator_loader=None):
    request = validate_request(request)
    job_dir=Path(request['jobDir']);job_dir.mkdir(parents=True,exist_ok=True)
    def event(stage, progress=0, state='running', message='', **fields):
        value=dict(version=1,jobId=request['jobId'],state=state,stage=stage,progress=progress,message=message,**fields)
        emit(value);return value
    event('checking')
    checks=inspect_creation(request)
    blockers=[x['detail'] for x in checks if x['state']!='ready' and x['id']!='weights']
    if blockers:raise ValueError('; '.join(blockers))
    event('copying')
    source=Path(request['sourceFile']);source_dir=safe_path(job_dir,'source');source_dir.mkdir(exist_ok=True)
    own=source_dir/('input'+source.suffix.lower());temporary=own.with_suffix(own.suffix+'.tmp')
    expected=request.get('sourceFingerprint')
    if not isinstance(expected,str) or not re.fullmatch(r'\d+:\d+:\d+:-?\d+',expected):
        raise ValueError('Source was not checked: select the file again.')
    def identity(value):
        return ':'.join(str(x) for x in (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns))
    def unchanged(value):
        if not stat.S_ISREG(value.st_mode) or identity(value)!=expected:
            raise ValueError('Source changed: select the file again.')
    try:
        with os.fdopen(os.open(source,os.O_RDONLY|os.O_NOFOLLOW),'rb') as opened:
            unchanged(os.fstat(opened.fileno()));unchanged(source.stat(follow_symlinks=False))
            with temporary.open('wb') as destination:shutil.copyfileobj(opened,destination)
            unchanged(os.fstat(opened.fileno()));unchanged(source.stat(follow_symlinks=False))
        os.replace(temporary,own)
    except (OSError,ValueError) as error:
        temporary.unlink(missing_ok=True)
        raise ValueError('Source changed or is unavailable: select the file again.') from error
    if any(x['id']=='weights' and x['state']!='ready' for x in checks):
        event('downloading')
        def download_progress(value):
            label=value.get('label') or value['file']
            message=f"{label}: {value['downloadedBytes']/1048576:.1f} / {value['totalBytes']/1048576:.1f} MB"
            event('downloading',value['progress'],message=message,downloadedBytes=value['downloadedBytes'],totalBytes=value['totalBytes'])
        ensure_creation_models(request,download_progress)
        # The saved source remains valid if the user's original disappears during the download.
        checks=inspect_creation({**request,'sourceFile':str(own)})
        blockers=[x['detail'] for x in checks if x['state']!='ready']
        if blockers:raise ValueError('; '.join(blockers))
    event('normalizing')
    normalized=normalize_media(own,request['sourceKind'],safe_path(job_dir,'input'))
    output=safe_path(job_dir,'output');output.mkdir(exist_ok=True)
    generator=(generator_loader(request['model']) if generator_loader else local_generator(request['model'],request['root']))
    args=dict(video_path=str(normalized),avatar_id=request['avatarId'],save_path=str(output),progress_callback=lambda p:event('generating',max(0,min(100,int(p)))))
    args.update(request['parameters'])
    if request['model']=='wav2lip':args['img_size']=256
    else:args['version']='v15'
    event('generating');generator(**args)
    event('validating')
    avatar=safe_path(output,request['avatarId']);count=validate_generated_avatar(avatar,request['model'])
    first=sorted((avatar/'full_imgs').iterdir(),key=lambda x:int(x.stem))[0]
    preview_media(first,'image',avatar/'thumbnail.jpg')
    return event('validating',100,'prepared',frameCount=count)


def main(argv=None):
    parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group(required=True)
    for mode in ('job','probe','preview','publish'):group.add_argument('--'+mode)
    args=parser.parse_args(argv);request={}
    try:
        filename=args.job or args.probe or args.preview or args.publish
        if Path(filename).stat().st_size>65536:raise ValueError('Job is too large.')
        request=json.loads(Path(filename).read_text())
        if args.job:
            run_job(request,lambda value:print('LT_AVATAR '+json.dumps(value,ensure_ascii=False),flush=True))
        elif args.probe:
            print('LT_AVATAR_PROBE '+json.dumps(inspect_creation(request),ensure_ascii=False),flush=True)
        elif args.preview:
            import resource
            resource.setrlimit(resource.RLIMIT_AS,(1024*1024*1024,1024*1024*1024))
            destination=Path(filename).parent/'preview.jpg'
            preview_media(Path(request['sourceFile']),request['sourceKind'],destination)
            print('LT_AVATAR_PREVIEW '+json.dumps({'path':str(destination)}),flush=True)
        else:
            root=Path(request['root']).resolve(strict=True)
            job_id=Path(request['jobDir']).name;avatar_id=request['avatarId']
            if request.get('schemaVersion')!=1 or not re.fullmatch(r'[a-f0-9-]{32,36}',job_id) or not re.fullmatch(r'studio_[a-f0-9]{32}',avatar_id):raise ValueError('Invalid publishing request.')
            job=safe_path(root,'data','.studio-avatar-work',job_id)
            if job!=Path(request['jobDir']).absolute():raise ValueError('Publishing path is outside the working directory.')
            staged=safe_path(job,'output',avatar_id);final=safe_path(root,'data','avatars',avatar_id)
            final.parent.mkdir(parents=True,exist_ok=True);publish_directory(staged,final)
            print('LT_AVATAR_PUBLISH '+json.dumps({'version':1,'avatarId':avatar_id,'path':str(final)}),flush=True)
        return 0
    except Exception as error:
        value=dict(version=1,jobId=request.get('jobId',''),state='failed',stage='checking',progress=0,message=str(error))
        print('LT_AVATAR '+json.dumps(value,ensure_ascii=False),flush=True)
        return 1

if __name__=='__main__':
    raise SystemExit(main())
