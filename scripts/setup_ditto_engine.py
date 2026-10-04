#!/usr/bin/env python3
"""Install the pinned Ditto backend without changing LiveTalking's environment.

Run with LiveTalking/.venv/bin/python. Requires uv and network access. The new
venv reads the existing PyTorch environment through a .pth overlay; all additions
are installed in Ditto's own venv. Keep the base environment available.
"""
import argparse
import json
import os
from pathlib import Path
import site
import subprocess
import sys

CODE_REVISION = "c3e47eee2e626500017a0556b470d6d4182f85e8"
MODEL_REVISION = "e4a2f60328ee7c32af585ac4b3cce299e4c8e254"
DEPENDENCIES = [
    "filetype==1.2.0", "imageio==2.37.0", "imageio-ffmpeg==0.6.0",
    "scikit-image==0.25.2", "Cython==3.0.12", "mediapipe==0.10.21",
    "onnxruntime-gpu==1.23.2", "absl-py==2.3.1", "flatbuffers==25.9.23",
    "tifffile==2025.6.11", "matplotlib==3.10.8", "contourpy==1.3.3",
    "cycler==0.12.1", "fonttools==4.61.1", "kiwisolver==1.4.9",
    "pyparsing==3.3.1", "sounddevice==0.5.3", "protobuf==4.25.8",
    "python-dateutil==2.9.0.post0", "six==1.17.0",
]
MODEL_FILES = [
    "aux_models/2d106det.onnx", "aux_models/det_10g.onnx",
    "aux_models/face_landmarker.task", "aux_models/hubert_streaming_fix_kv.onnx",
    "aux_models/landmark203.onnx", "models/appearance_extractor.pth",
    "models/decoder.pth", "models/lmdm_v0.4_hubert.pth",
    "models/motion_extractor.pth", "models/stitch_network.pth", "models/warp_network.pth",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    checkout = Path(__file__).resolve().parents[1]
    parser.add_argument("--root", type=Path, default=checkout.parent / "ditto-talkinghead")
    parser.add_argument("--runtime", type=Path, default=checkout / "models/ditto/runtime.json")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.exists():
        subprocess.run(["git", "clone", "https://github.com/antgroup/ditto-talkinghead.git", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "checkout", "--detach", CODE_REVISION], check=True)
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if revision != CODE_REVISION:
        raise SystemExit(f"Expected Ditto revision {CODE_REVISION}, found {revision}; use a separate checkout")
    python = root / ".venv/bin/python"
    env = dict(os.environ, UV_CACHE_DIR=str(root / ".uv-cache"), HF_HUB_DISABLE_XET="1")
    if not python.exists():
        subprocess.run(["uv", "venv", "--python", sys.executable, str(root / ".venv")], env=env, check=True)
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    target_site = root / ".venv/lib" / version / "site-packages"
    if not target_site.exists():
        raise SystemExit("Ditto environment Python version differs from this interpreter")
    base_site = site.getsitepackages()[0]
    if Path(base_site).resolve() == target_site.resolve():
        raise SystemExit("Run setup with the LiveTalking interpreter, not the Ditto interpreter")
    (target_site / "livetalking-shared.pth").write_text(base_site + "\n")
    subprocess.run(["uv", "pip", "install", "--python", str(python), "--no-deps", *DEPENDENCIES], env=env, check=True)
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    from huggingface_hub import snapshot_download
    weights = root / "checkpoints/ditto_pytorch"
    cfg = root / "checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"
    snapshot_download("digital-avatar/ditto-talkinghead", revision=MODEL_REVISION,
                      allow_patterns=["ditto_cfg/v0.4_hubert_cfg_pytorch.pkl", "ditto_pytorch/**"],
                      local_dir=str(root / "checkpoints"), max_workers=4)
    required = [cfg, *(weights / name for name in MODEL_FILES)]
    for path in required:
        if not path.is_file() or path.stat().st_size == 0:
            raise SystemExit(f"Missing downloaded model: {path}")
    subprocess.run([str(python), "-c", "import torch, onnxruntime, mediapipe, librosa, filetype, imageio, skimage, Cython"], check=True)
    runtime = {
        "python": str(python), "root": str(root), "weights": str(weights), "cfg": str(cfg),
        "revision": CODE_REVISION, "model_revision": MODEL_REVISION,
        "required_files": [str(path) for path in required],
        "probe_imports": ["torch", "onnxruntime", "mediapipe", "librosa", "filetype", "imageio", "skimage", "Cython"],
        "sampling_timesteps": 50,
    }
    args.runtime.parent.mkdir(parents=True, exist_ok=True)
    args.runtime.write_text(json.dumps(runtime, indent=2) + "\n")
    print(f"Ditto runtime configured: {args.runtime}")


if __name__ == "__main__":
    main()
