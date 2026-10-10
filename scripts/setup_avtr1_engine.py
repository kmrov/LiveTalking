#!/usr/bin/env python3
"""Install AVTR-1 in its own Pixi environment and register it with Studio.

Run explicitly after checking out avtr-1 beside LiveTalking. This does not
change the LiveTalking Python environment or start a Studio service.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess


REQUIRED_FILES = (
    *(f'renderer_runtime_artifacts/{name}.onnx' for name in (
        'appearance_extractor', 'motion_extractor', 'landmark106', 'landmark203',
        'insightface_det', 'blaze_face', 'face_mesh')),
    'renderer_runtime_artifacts/libgrid_sample_3d_plugin.so',
    'avatars_artifacts/pasteback_mask.png',
    *(f'build_artifacts/{name}' for name in (
        'decoder.onnx', 'warp_network.onnx', 'warp_network_ori.onnx',
        'stitch_network.onnx', 'modnet.onnx', 'hubert-lbs-avtr1.onnx',
        'avtr1.scripted.pt')),
    *(f'renderer_runtime_artifacts_cc/{name}_b5_fp16.engine' for name in (
        'decoder', 'warp_network', 'stitch_network', 'modnet')),
    *(f'speech2motion_runtime_artifacts_cc/{name}_fp16.engine' for name in (
        'hubert_lbs', 'avtr1_encode', 'avtr1_decode')),
    'avtr1_normalizer.safetensors',
)
REQUIRED_DIRS = ('avatars_artifacts/backgrounds', 'avatars_artifacts/reference_frames')


def configure_runtime(root: Path, weights: Path, runtime: Path) -> dict:
    """Validate an installed AVTR-1 renderer and write its Studio manifest."""
    root, weights, runtime = root.resolve(), weights.resolve(), runtime.resolve()
    python = root / '.pixi/envs/renderer/bin/python'
    if not (root / 'pixi.toml').is_file():
        raise ValueError(f'AVTR-1 checkout missing pixi.toml: {root}')
    if not python.is_file() or not os.access(python, os.X_OK):
        raise ValueError(f'AVTR-1 Pixi renderer Python is missing: {python}')
    if weights.name != 'main':
        raise ValueError('AVTR-1 artifact directory must point to revision main.')
    if not weights.is_dir():
        raise ValueError(f'AVTR-1 artifact directory is missing: {weights}')
    required = [weights / name for name in REQUIRED_FILES]
    missing = [str(file) for file in required if not file.is_file() or not file.stat().st_size]
    if missing:
        raise ValueError(f'AVTR-1 artifact missing or empty: {missing[0]}')
    for name in REQUIRED_DIRS:
        if not (weights / name).is_dir():
            raise ValueError(f'AVTR-1 artifact directory missing: {weights / name}')
    config = {
        'python': str(python), 'root': str(root), 'weights': str(weights),
        'required_files': list(map(str, required)),
        'probe_imports': ['avtr1_renderer', 'torch', 'tensorrt'],
        'output_size': 768,
        'buffered_playback': False,
    }
    runtime.parent.mkdir(parents=True, exist_ok=True)
    temporary = runtime.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(config, indent=2) + '\n')
    temporary.replace(runtime)
    return config


def main(argv=None):
    checkout = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=checkout.parent / 'avtr-1')
    parser.add_argument('--runtime', type=Path, default=checkout / 'models/avtr1/runtime.json')
    parser.add_argument('--storage', type=Path, help='Artifact base; defaults to AVTR1_LOCAL_STORAGE or <root>/artifacts')
    parser.add_argument('--configure-only', action='store_true', help='Validate an existing Pixi installation and artifacts')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if not (root / 'pixi.toml').is_file():
        raise SystemExit(f'AVTR-1 checkout not found at {root}; clone https://github.com/avaturn-live/avtr-1.git first.')
    storage = (args.storage or Path(os.environ.get('AVTR1_LOCAL_STORAGE', root / 'artifacts'))).resolve()
    weights = storage / 'main'
    if not args.configure_only:
        environment = {**os.environ, 'AVTR1_LOCAL_STORAGE': str(storage),
                       'PATH': str(root / '.pixi/envs/renderer/bin') + os.pathsep + os.environ.get('PATH', '')}
        subprocess.run(['pixi', 'install'], cwd=root, env=environment, check=True)
        python = root / '.pixi/envs/renderer/bin/python'
        for script in ('download_artifacts.py', 'build_engines.py'):
            subprocess.run([str(python), str(root / 'scripts' / script)], cwd=root, env=environment, check=True)
    configure_runtime(root, weights, args.runtime)
    print(f'AVTR-1 runtime configured: {args.runtime}')


if __name__ == '__main__':
    main()
