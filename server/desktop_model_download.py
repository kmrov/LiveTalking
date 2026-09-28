"""Verified, cancellable downloads of the fixed Studio model catalogue."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import tempfile
import time
from urllib.request import urlopen


class DownloadCancelled(Exception):
    pass


def _safe_target(base, relative):
    base = Path(base).resolve()
    parts = PurePosixPath(relative).parts
    if not parts or PurePosixPath(relative).is_absolute() or any(x in ('.', '..') for x in parts) or '\\' in relative:
        raise ValueError('Недопустимый путь модели.')
    target = base
    for part in parts:
        target = target / part
        if target.is_symlink():
            # Existing HF cache files may be links to its own blobs; never write through a link.
            if target == base.joinpath(*parts) and target.is_file() and target.resolve().is_relative_to(base):
                return target
            raise ValueError('Путь модели проходит через символическую ссылку.')
    return target


def _present(path):
    return path.is_file() and path.stat().st_size > 0


@contextlib.contextmanager
def _lock(folder, cancelled):
    folder.mkdir(parents=True, exist_ok=True)
    file = folder / '.studio-model-download.lock'
    fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            if cancelled():
                raise DownloadCancelled('Загрузка отменена.')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.1)
        yield
    finally:
        os.close(fd)


def download_file(base, relative, spec, *, open_url=urlopen, emit=lambda _event: None, cancelled=lambda: False):
    target = _safe_target(base, relative)
    if _present(target):
        return target
    if target.exists():
        raise ValueError(f'Файл модели пуст или непригоден: {target}. Уберите его и повторите загрузку.')
    if not re.fullmatch(r'[0-9a-f]{40}', spec['revision']) or not re.fullmatch(r'[\w.-]+/[\w.-]+', spec['repo']):
        raise ValueError('Недопустимый источник модели.')
    source = PurePosixPath(spec['file'])
    if source.is_absolute() or any(x in ('.', '..') for x in source.parts):
        raise ValueError('Недопустимый файл модели.')
    target.parent.mkdir(parents=True, exist_ok=True)
    with _lock(target.parent, cancelled):
        if _present(target):
            return target
        size = spec['size']
        if type(size) is not int or size <= 0:
            raise ValueError('Некорректный размер модели.')
        if shutil.disk_usage(target.parent)[2] < size:
            raise OSError('Недостаточно места для загрузки модели.')
        url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{spec['file']}?download=true"
        algorithm = spec['algorithm']
        digest = hashlib.sha256() if algorithm == 'sha256' else hashlib.sha1() if algorithm == 'git-sha1' else None
        if digest is None:
            raise ValueError('Неподдерживаемая проверка модели.')
        if algorithm == 'git-sha1':
            digest.update(f'blob {size}\0'.encode())
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.studio-model-', suffix='.part', delete=False) as output:
                temporary = Path(output.name)
                done = 0
                with open_url(url, timeout=30) as response:
                    while True:
                        if cancelled():
                            raise DownloadCancelled('Загрузка отменена.')
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        done += len(chunk)
                        if done > size:
                            raise ValueError('Размер загруженной модели не совпал.')
                        digest.update(chunk)
                        output.write(chunk)
                        emit({'file':spec['file'], 'downloadedBytes':done, 'totalBytes':size, 'progress':min(100, int(done*100/size))})
                    if cancelled():
                        raise DownloadCancelled('Загрузка отменена.')
                if done != size or digest.hexdigest() != spec['digest']:
                    raise ValueError(f"Проверка файла {spec['file']} не прошла; повторите загрузку.")
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o644)
            # Atomic no-replace publication: a race cannot overwrite an existing model.
            os.link(temporary, target)
            return target
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def speech_cache(root):
    if os.environ.get('HF_HUB_CACHE'):
        return Path(os.environ['HF_HUB_CACHE'])
    if os.environ.get('HF_HOME'):
        return Path(os.environ['HF_HOME'])/'hub'
    adjacent = Path(root).parent/'.hf-cache-qwen'
    if adjacent.is_dir():
        return adjacent/'hub'
    return Path(os.environ.get('XDG_CACHE_HOME', Path.home()/'.cache'))/'huggingface/hub'


def _speech_ready(base, repo, needs_tokenizer):
    folder = Path(base)/('models--'+repo.replace('/','--'))
    try:
        revision = (folder/'refs/main').read_text().strip()
        if not re.fullmatch(r'[0-9a-f]{40}',revision):
            return False
        snapshot = folder/'snapshots'/revision
        required=['config.json','tokenizer_config.json','preprocessor_config.json','vocab.json','merges.txt']
        if needs_tokenizer:
            required+=['speech_tokenizer/config.json','speech_tokenizer/preprocessor_config.json']
        return all(_present(snapshot/name) for name in required) and _weights_ready(snapshot) and (not needs_tokenizer or _weights_ready(snapshot/'speech_tokenizer'))
    except OSError:
        return False


def _weights_ready(folder):
    if any(_present(folder/name) for name in ['model.safetensors','pytorch_model.bin']):
        return True
    for name in ['model.safetensors.index.json','pytorch_model.bin.index.json']:
        try:
            shards=list(json.loads((folder/name).read_text()).get('weight_map',{}).values())
            if shards and all(isinstance(file,str) and Path(file).name==file and _present(folder/file) for file in shards):
                return True
        except (OSError, ValueError, AttributeError):
            pass
    return False


def model_download_plan(root, model, *, scope, speech_mode='external', torch_hub=None, speech_hub=None):
    root = Path(root).resolve(strict=True)
    if scope not in ('creation','start') or model not in ('musetalk','wav2lip','ultralight') or speech_mode not in ('local','external'):
        raise ValueError('Некорректные параметры загрузки моделей.')
    if scope=='creation' and model=='ultralight':
        raise ValueError('Создание Ultralight не поддерживается.')
    selected = (['s3fd','musetalk','vae','face-parsing'] if model=='musetalk' else ['s3fd']) if scope=='creation' else {'musetalk':['musetalk','vae','whisper'],'wav2lip':['wav2lip'],'ultralight':['hubert']}[model]
    if scope=='start' and speech_mode=='local':
        selected += ['asr','tts']
    torch_hub = Path(torch_hub) if torch_hub is not None else Path(os.environ.get('TORCH_HOME', Path(os.environ.get('XDG_CACHE_HOME',Path.home()/'.cache'))/'torch'))/'hub'
    speech_hub = Path(speech_hub) if speech_hub is not None else speech_cache(root)
    catalog = json.loads(Path(__file__).with_name('desktop-model-catalog.json').read_text())['groups']
    plan=[]
    for name in selected:
        group=catalog[name]
        base={'checkout':root,'torch':torch_hub,'speech':speech_hub}[group['storage']]
        if group['storage']=='speech' and _speech_ready(base,group['repo'],name=='tts'):
            continue
        for file in group['files']:
            relative=file['destination']
            if group['storage']=='speech':
                relative='models--'+group['repo'].replace('/','--')+'/snapshots/'+group['revision']+'/'+relative
            if name=='s3fd':
                package='avatars/musetalk/utils/face_detection' if model=='musetalk' else 'avatars/wav2lip/face_detection'
                bundled=root/package/'detection/sfd/s3fd.pth'
                if _present(bundled):
                    continue
            plan.append({**file,'repo':group['repo'],'revision':group['revision'],'storage':group['storage'],'base':base,'relative':relative,'label':group['label']})
    return plan


@contextlib.contextmanager
def _cancellation():
    def stop(_signum,_frame):
        raise DownloadCancelled('Загрузка отменена.')
    previous=signal.signal(signal.SIGTERM,stop)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM,previous)


def ensure_models(request, emit, *, scope):
    plan=model_download_plan(request['root'],request['model'],scope=scope,speech_mode=request.get('speechMode','external'))
    missing=[entry for entry in plan if not _present(_safe_target(entry['base'],entry['relative']))]
    total=sum(entry['size'] for entry in missing)
    completed=0
    last=0.0
    with _cancellation():
        for entry in missing:
            def progress(value):
                nonlocal last
                now=time.monotonic()
                if now-last>=0.2 or value['downloadedBytes']==entry['size']:
                    last=now
                    done=completed+value['downloadedBytes']
                    emit({**value,'label':entry['label'],'downloadedBytes':done,'totalBytes':total,'progress':min(100,int(done*100/max(1,total)))})
            emit({'file':entry['file'],'label':entry['label'],'downloadedBytes':completed,'totalBytes':total,'progress':int(completed*100/max(1,total))})
            download_file(entry['base'],entry['relative'],entry,emit=progress)
            completed+=entry['size']
        # A HF snapshot is advertised only after every file has been installed.
        for repo,revision,base in {(x['repo'],x['revision'],x['base']) for x in plan if x['storage']=='speech'}:
            reference=_safe_target(base,'models--'+repo.replace('/','--')+'/refs/main')
            reference.parent.mkdir(parents=True,exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=reference.parent,delete=False) as output:
                temporary=Path(output.name)
                output.write(revision.encode());output.flush();os.fsync(output.fileno())
            try:
                os.replace(temporary,reference)
            finally:
                temporary.unlink(missing_ok=True)


def ensure_creation_models(request,emit):
    return ensure_models(request,emit,scope='creation')
