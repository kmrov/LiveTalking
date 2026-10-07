"""SoulX FlashHead Lite streaming adapter, imported only by its isolated worker."""
from contextlib import contextmanager
import gc
import importlib
import os
from pathlib import Path
import sys
import tempfile
import time

import numpy as np
import torch
from PIL import Image


@contextmanager
def _working_directory(path):
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


class Engine:
    fps = 20
    sample_rate = 16000
    startup_frames = 8

    def __init__(self, config):
        self.config = dict(config)
        self.pipeline = None
        self.api = None
        self.chunk_frames = 0
        self.chunk_samples = 0
        self._audio = None
        self._seed = int(config.get("seed", 9999))
        self._reference_dir = None
        self._content_box = None

    def start(self, source):
        if self.pipeline is not None:
            raise RuntimeError("SoulX engine already started")
        for key in ("root", "weights", "wav2vec"):
            path = Path(self.config[key])
            if not path.is_absolute() or not path.is_dir():
                raise ValueError(f"SoulX {key} must be an existing absolute directory")
        source = Path(source)
        if not source.is_absolute() or not source.is_file() or source.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            raise ValueError("SoulX source must be an absolute PNG/JPEG file")
        # Upstream always center-crops to a square, even with face crop off.
        # Pad first and remove the corresponding output margins so the parent
        # can scale to the original reference without losing edges/stretching.
        if not self.config.get("face_crop", False):
            with Image.open(source) as original:
                width, height = original.size
                if width != height:
                    side = max(width, height)
                    left, top = (side - width) // 2, (side - height) // 2
                    padded = Image.new("RGB", (side, side))
                    padded.paste(original.convert("RGB"), (left, top))
                    self._reference_dir = tempfile.TemporaryDirectory(prefix="studio-soulx-")
                    source = Path(self._reference_dir.name) / "reference.png"
                    padded.save(source)
                    self._content_box = (left / side, top / side,
                        (left + width) / side, (top + height) / side)
        root = self.config["root"]
        if root not in sys.path:
            sys.path.insert(0, root)
        # Upstream opens its inference YAML relative to cwd during import.
        with _working_directory(root):
            self.api = importlib.import_module("flash_head.inference")
            module = importlib.import_module("flash_head.src.pipeline.flash_head_pipeline")
            # Compilation is optional: cold compilation can take minutes and
            # much more host/GPU memory than eager inference on consumer GPUs.
            module.COMPILE_MODEL = bool(self.config.get("compile", False))
            module.COMPILE_VAE = bool(self.config.get("compile", False))
            weights_started_at = time.monotonic()
            self.pipeline = self.api.get_pipeline(world_size=1,
                ckpt_dir=self.config["weights"], model_type="lite",
                wav2vec_dir=self.config["wav2vec"])
            print(f'LT_TIMING SoulX pipeline load: {time.monotonic() - weights_started_at:.2f}s', file=sys.stderr, flush=True)
            # This Lite checkpoint accepts 8n+1 temporal windows. Keep
            # its 33-frame window: nine motion frames plus 24 frames spanning
            # 1.2 seconds at the genuine 20 fps model sampling rate.
            self.api.infer_params['tgt_fps'] = self.fps
            self.api.infer_params['frame_num'] = 33
            self.api.infer_params['sample_steps'] = 2
            params = self.api.get_infer_params()
            if (params["sample_rate"] != self.sample_rate or params["tgt_fps"] != self.fps
                    or params['frame_num'] != 33 or params['sample_steps'] != 2):
                self.close()
                raise RuntimeError("SoulX requires 16000 Hz audio, 20 fps, and two sampling steps")
            self._frame_num = int(params["frame_num"])
            self._motion_frames = int(params["motion_frames_num"])
            self.chunk_frames = self._frame_num - self._motion_frames
            self.chunk_samples = self.chunk_frames * self.sample_rate // self.fps
            cache_samples = int(params["cached_audio_duration"] * self.sample_rate)
            self._audio_end = int(params["cached_audio_duration"] * self.fps)
            self._audio_start = self._audio_end - self._frame_num
            if self.chunk_frames <= 0 or self._audio_start < 0:
                self.close()
                raise RuntimeError("Unsupported SoulX streaming frame configuration")
            self._audio = np.zeros(cache_samples, dtype=np.float32)
            reference_started_at = time.monotonic()
            self.api.get_base_data(self.pipeline, cond_image_path_or_dir=str(source),
                base_seed=self._seed, use_face_crop=bool(self.config.get("face_crop", False)))
            # Reuse the same reference and motion state for the short first
            # block. Subsequent blocks keep the established 24-frame window.
            reference = self.pipeline.cond_image_tensor_dict[self.pipeline.person_name]
            with torch.no_grad():
                self._startup_ref_latent = self.pipeline.vae.encode(
                    reference.repeat(1, 1, self._motion_frames + self.startup_frames, 1, 1))
            print(f'LT_TIMING SoulX reference: {time.monotonic() - reference_started_at:.2f}s', file=sys.stderr, flush=True)

    def render(self, audio):
        if self.pipeline is None:
            raise RuntimeError("SoulX engine is not started")
        startup_samples = self.startup_frames * self.sample_rate // self.fps
        if (not isinstance(audio, np.ndarray) or audio.dtype != np.float32
                or audio.shape not in ((self.chunk_samples,), (startup_samples,))
                or not np.isfinite(audio).all()):
            raise ValueError(f"SoulX needs {startup_samples} or {self.chunk_samples} finite mono float32 samples")
        startup = audio.size == startup_samples
        frame_num = self._motion_frames + (self.startup_frames if startup else self.chunk_frames)
        if startup:
            self.pipeline.frame_num = frame_num
            self.pipeline.ref_img_latent = self._startup_ref_latent
            self.api.infer_params['frame_num'] = frame_num
        count = len(audio)
        self._audio[:-count] = self._audio[count:]
        self._audio[-count:] = audio
        try:
            embedding = self.api.get_audio_embedding(self.pipeline, self._audio,
                self._audio_end - frame_num, self._audio_end)
            video = self.api.run_pipeline(self.pipeline, embedding)
        finally:
            if startup:
                self.pipeline.frame_num = self._frame_num
                self.pipeline.ref_img_latent = self.pipeline.ref_img_latent_dict[self.pipeline.person_name]
                self.api.infer_params['frame_num'] = self._frame_num
        # Upstream generates the preceding nine motion frames as context.
        # Their audio is already in the rolling cache; never publish them twice.
        if video.ndim != 4 or video.shape[0] != frame_num or video.shape[-1] != 3:
            raise RuntimeError(f"SoulX returned invalid frames: {tuple(video.shape)}")
        video = video[self._motion_frames:].detach().float().cpu().numpy()
        if self._content_box is not None:
            height, width = video.shape[1:3]
            left, top, right, bottom = self._content_box
            x0, y0 = round(left * width), round(top * height)
            x1, y1 = round(right * width), round(bottom * height)
            video = video[:, y0:max(y0 + 1, y1), x0:max(x0 + 1, x1)]
        return np.ascontiguousarray(np.clip(video, 0, 255), dtype=np.uint8)

    def reset(self):
        if self.pipeline is None:
            raise RuntimeError("SoulX engine is not started")
        self._audio.fill(0)
        # This resets motion from the cached reference latent without running
        # the expensive image VAE again. Rewind noise as for a fresh utterance.
        self.pipeline.reset_person_name()
        self.pipeline.generator.manual_seed(self._seed)

    def close(self):
        self.pipeline = None
        self._audio = None
        self._startup_ref_latent = None
        if self._reference_dir is not None:
            self._reference_dir.cleanup()
            self._reference_dir = None
        self._content_box = None
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_initialized():
            torch.cuda.empty_cache()
