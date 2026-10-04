"""Validate explicitly installed, isolated generative avatar runtimes."""
import json
import os
from pathlib import Path
import re
import subprocess

MODELS = ('ditto', 'soulx')


def load_runtime(root, model):
    if model not in MODELS:
        raise ValueError('Unsupported generative avatar model.')
    file = Path(root).resolve() / 'models' / model / 'runtime.json'
    if not file.is_file() or file.stat().st_size > 65536:
        raise ValueError(f'Install {model}: runtime configuration missing: {file}')
    config = json.loads(file.read_text())
    if not isinstance(config, dict):
        raise ValueError('Invalid runtime configuration.')
    for key in ('python', 'root', 'weights') + (('wav2vec',) if model == 'soulx' else ()):
        value = config.get(key)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError(f'Runtime {key} must be an absolute path.')
        if not Path(value).exists():
            raise ValueError(f'Runtime {key} is missing: {value}')
    if not Path(config['python']).is_file() or not os.access(config['python'], os.X_OK):
        raise ValueError('Runtime Python is not executable.')
    if not Path(config['root']).is_dir() or not Path(config['weights']).is_dir():
        raise ValueError('Runtime root and weights must be directories.')
    files = config.get('required_files')
    if not isinstance(files, list) or not files:
        raise ValueError('Runtime required weight files are not declared.')
    for name in files:
        if not isinstance(name, str) or not Path(name).is_absolute() or not Path(name).is_file() or not Path(name).stat().st_size:
            raise ValueError(f'Runtime weight file missing or empty: {name}')
    imports = config.get('probe_imports', [])
    if not isinstance(imports, list) or any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*', x) for x in imports):
        raise ValueError('Invalid runtime import checks.')
    return {**config, 'probe_imports': imports, 'model': model, 'checkout': str(Path(root).resolve())}


def inspect_runtime(root, model):
    try:
        config = load_runtime(root, model)
        code = 'import importlib,json,sys; [importlib.import_module(x) for x in json.loads(sys.argv[1])]'
        result = subprocess.run([config['python'], '-c', code, json.dumps(config['probe_imports'])],
                                cwd=config['root'], capture_output=True, text=True, timeout=25)
        if result.returncode:
            raise ValueError((result.stderr.strip().splitlines() or ['Runtime import failed.'])[-1])
        return {'ok': True, 'detail': f'{model}: isolated runtime and required weights found'}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {'ok': False, 'detail': str(error)}
