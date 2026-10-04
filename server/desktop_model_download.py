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
import stat
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class DownloadCancelled(Exception):
    pass


class _InvalidModel(ValueError):
    """Bytes known to be unusable must not be retained for another attempt."""


def _partial_file(target, spec):
    identity = json.dumps({key: spec[key] for key in ('repo','revision','file','size','algorithm','digest')}, sort_keys=True)
    key = hashlib.sha256((target.name + '\0' + identity).encode()).hexdigest()
    return target.parent / f'.studio-model-{key}.part'


def _digest(spec):
    if spec['algorithm'] == 'sha256':
        return hashlib.sha256()
    if spec['algorithm'] == 'git-sha1':
        digest = hashlib.sha1()
        digest.update(f"blob {spec['size']}\0".encode())
        return digest
    raise ValueError('Unsupported model checksum.')


def _response(open_url, url, offset):
    headers = {'Accept-Encoding': 'identity'}
    if offset:
        headers['Range'] = f'bytes={offset}-'
    try:
        return open_url(Request(url, headers=headers), timeout=30)
    except HTTPError as error:
        if error.code != 416 or not offset:
            raise
        error.close()
        return open_url(Request(url, headers={'Accept-Encoding': 'identity'}), timeout=30)


def _response_end(response, offset, size):
    status = getattr(response, 'status', 200)
    headers = getattr(response, 'headers', {})
    if headers.get('Content-Encoding', 'identity').lower() != 'identity':
        raise ValueError('Server returned a compressed file instead of raw model bytes.')
    if status == 206:
        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', headers.get('Content-Range') or '')
        if not match:
            raise ValueError('Server did not confirm the download range.')
        first, last, total = map(int, match.groups())
        if first != offset or not first <= last < size or total != size:
            raise ValueError('Download range does not match the saved model.')
        end = last + 1
    elif status == 200:
        offset, end = 0, size
    else:
        raise ValueError(f'Unsupported download response: HTTP {status}.')
    length = headers.get('Content-Length')
    if length is not None and (not re.fullmatch(r'\d+', str(length)) or int(length) != end-offset):
        raise ValueError('Server response size does not match the model.')
    return offset, end


def _safe_target(base, relative):
    base = Path(base).resolve()
    parts = PurePosixPath(relative).parts
    if not parts or PurePosixPath(relative).is_absolute() or any(x in ('.', '..') for x in parts) or '\\' in relative:
        raise ValueError('Invalid model path.')
    target = base
    for part in parts:
        target = target / part
        if target.is_symlink():
            # Existing HF cache files may be links to its own blobs; never write through a link.
            if target == base.joinpath(*parts) and target.is_file() and target.resolve().is_relative_to(base):
                return target
            raise ValueError('Model path contains a symbolic link.')
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
                raise DownloadCancelled('Download cancelled.')
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
        raise ValueError(f'Model file is empty or invalid: {target}. Remove it and retry the download.')
    if not re.fullmatch(r'[0-9a-f]{40}', spec['revision']) or not re.fullmatch(r'[\w.-]+/[\w.-]+', spec['repo']):
        raise ValueError('Invalid model source.')
    source = PurePosixPath(spec['file'])
    if source.is_absolute() or any(x in ('.', '..') for x in source.parts):
        raise ValueError('Invalid model file.')
    target.parent.mkdir(parents=True, exist_ok=True)
    with _lock(target.parent, cancelled):
        if _present(target):
            return target
        size = spec['size']
        if type(size) is not int or size <= 0:
            raise ValueError('Invalid model size.')
        url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{spec['file']}?download=true"
        digest = _digest(spec)
        temporary = _partial_file(target, spec)
        if cancelled():
            raise DownloadCancelled('Download cancelled.')
        fd = os.open(temporary, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('Invalid temporary model file.')
            # Unbuffered writes retain each received chunk even after a forced process exit.
            with os.fdopen(fd, 'r+b', buffering=0) as output:
                fd = None
                done = info.st_size
                if done > size:
                    raise _InvalidModel('Saved part is larger than the model file; retry the download.')
                def progress():
                    emit({'file':spec['file'], 'downloadedBytes':done, 'totalBytes':size, 'progress':int(done*100/size)})
                if done:
                    progress()
                while True:
                    if cancelled():
                        raise DownloadCancelled('Download cancelled.')
                    chunk = output.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                if done < size:
                    if shutil.disk_usage(target.parent)[2] < size-done:
                        raise OSError('Not enough disk space to download the model.')
                    with _response(open_url, url, done) as response:
                        start, end = _response_end(response, done, size)
                        if start == 0 and done:
                            # Range is optional: preserve the old prefix until a full response is usable.
                            if shutil.disk_usage(target.parent)[2] < size:
                                raise OSError('Not enough disk space to restart the model download.')
                            output.seek(0); output.truncate(0)
                            done = 0; digest = _digest(spec)
                            progress()
                        while True:
                            if cancelled():
                                raise DownloadCancelled('Download cancelled.')
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            if done + len(chunk) > end:
                                raise _InvalidModel('Downloaded model size does not match.')
                            pending = memoryview(chunk)
                            while pending:
                                if cancelled():
                                    raise DownloadCancelled('Download cancelled.')
                                written = output.write(pending)
                                if not written:
                                    raise OSError('Could not save downloaded model bytes.')
                                pending = pending[written:]
                            done += len(chunk)
                            digest.update(chunk)
                            progress()
                if cancelled():
                    raise DownloadCancelled('Download cancelled.')
                if done != size:
                    raise ValueError('Download was interrupted; retry to resume the saved part.')
                if digest.hexdigest() != spec['digest']:
                    raise _InvalidModel(f"Validation of file {spec['file']} failed; retry the download.")
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), 0o644)
            # Atomic no-replace publication: a race cannot overwrite an existing model.
            os.link(temporary, target)
            temporary.unlink()
            return target
        except _InvalidModel:
            temporary.unlink(missing_ok=True)
            raise
        finally:
            if fd is not None:
                os.close(fd)


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
    if scope not in ('creation','start') or model not in ('musetalk','wav2lip','ultralight','ditto','soulx') or speech_mode not in ('local','external'):
        raise ValueError('Invalid model download parameters.')
    if scope=='creation' and model=='ultralight':
        raise ValueError('Ultralight creation is not supported.')
    if model in ('ditto','soulx'):
        selected = []
    else:
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
        raise DownloadCancelled('Download cancelled.')
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
