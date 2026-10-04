#!/usr/bin/env python3
"""Explicit, isolated installation of the pinned SoulX Lite worker runtime."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


REVISION = "9bc03de06bb0de82cd6bc477804512ae06144bf2"
MODEL_REVISION = "59119b6c681230c3eeee157e224ae1941746711e"
WAV2VEC_REVISION = "22aad52d435eb6dbaf354bdad9b0da84ce7d6156"
PACKAGES = [
    "torch==2.7.1", "torchvision==0.22.1", "numpy<2", "diffusers==0.34.0",
    "transformers==4.57.3", "accelerate>=1.8.1", "huggingface_hub<1",
    "einops", "loguru", "pyloudnorm", "librosa", "mediapipe==0.10.9",
    "opencv-python<4.12", "opencv-contrib-python<4.12", "imageio",
    "imageio-ffmpeg", "scikit-image", "easydict", "ftfy", "ninja",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    checkout = Path(__file__).resolve().parents[1]
    parser.add_argument("--root", type=Path, default=checkout.parent / "SoulX-FlashHead")
    parser.add_argument("--python", default="python3.11", help="Python 3.11 interpreter for the isolated venv")
    parser.add_argument("--runtime", type=Path, default=checkout / "models/soulx/runtime.json")
    parser.add_argument("--skip-install", action="store_true", help="Reuse an already installed isolated venv")
    parser.add_argument("--flash-attention", action="store_true",
                        help="Install official CUDA12/torch2.7/Python3.11 FlashAttention wheel")
    args = parser.parse_args()
    root = args.root.resolve()
    def run(*command, **kwargs):
        subprocess.run(list(map(str, command)), check=True, **kwargs)
    if not root.exists():
        run("git", "clone", "https://github.com/Soul-AILab/SoulX-FlashHead.git", root)
        run("git", "-C", root, "checkout", "--detach", REVISION)
    actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise SystemExit(f"SoulX checkout is {actual}; expected {REVISION}. Use a fresh --root directory.")
    python = root / ".venv/bin/python"
    if not args.skip_install:
        if not python.exists():
            run("uv", "venv", "--python", args.python, root / ".venv")
        run("uv", "pip", "install", "--python", python, *PACKAGES)
        # xfuser imports are required upstream even for world_size=1. Flash
        # attention is optional; torch's native SDPA remains supported upstream.
        run("uv", "pip", "install", "--python", python, "xfuser==0.4.3")
    if args.flash_attention:
        abi = subprocess.check_output([str(python), "-c",
            "import sys, torch; assert sys.version_info[:2] == (3, 11); print(str(torch._C._GLIBCXX_USE_CXX11_ABI).upper())"],
            text=True).strip()
        wheel = ("https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.0.post2/"
                 f"flash_attn-2.8.0.post2%2Bcu12torch2.7cxx11abi{abi}-cp311-cp311-linux_x86_64.whl")
        run("uv", "pip", "install", "--python", python, "--no-deps", wheel)
    weights = root / "models/SoulX-FlashHead-1_3B"
    wav2vec = root / "models/wav2vec2-base-960h"
    run(python, "-c", "\n".join([
        "from huggingface_hub import snapshot_download",
        f"snapshot_download('Soul-AILab/SoulX-FlashHead-1_3B', revision={MODEL_REVISION!r}, local_dir={str(weights)!r}, allow_patterns=['Model_Lite/*', 'VAE_LTX/*'])",
        f"snapshot_download('facebook/wav2vec2-base-960h', revision={WAV2VEC_REVISION!r}, local_dir={str(wav2vec)!r}, allow_patterns=['config.json', 'preprocessor_config.json', 'model.safetensors'])",
    ]))
    run(python, "-c", "import flash_head.inference; import flash_head.ltx_video.ltx_vae", cwd=root)
    required = [weights / part / name for part in ("Model_Lite", "VAE_LTX")
                for name in ("config.json", "diffusion_pytorch_model.safetensors")]
    required += [wav2vec / name for name in ("config.json", "preprocessor_config.json", "model.safetensors")]
    for path in required:
        if not path.is_file() or not path.stat().st_size:
            raise SystemExit(f"Required SoulX model file missing: {path}")
    config = dict(python=str(python), root=str(root), weights=str(weights), wav2vec=str(wav2vec),
                  revision=REVISION, model_revision=MODEL_REVISION, wav2vec_revision=WAV2VEC_REVISION,
                  required_files=list(map(str, required)),
                  probe_imports=["torch", "flash_head.inference", "flash_head.ltx_video.ltx_vae"],
                  compile=False, face_crop=False, buffered_playback=False)
    args.runtime.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.runtime.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(config, indent=2) + "\n")
    temporary.replace(args.runtime)
    print(f"SoulX Lite runtime ready: {args.runtime}")


if __name__ == "__main__":
    main()
