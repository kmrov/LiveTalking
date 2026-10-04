"""Persistent Ditto PyTorch engine; upstream revision c3e47eee2e626500017a0556b470d6d4182f85e8.

Twenty current frames follow sixty context frames in every diffusion window.
Only the current tail is emitted: the upstream online writer delays its first
window and cannot satisfy our synchronous audio/video contract. The last 80 ms
of Hubert lookahead is zero padded; it is never prepended to output audio.
"""
from contextlib import redirect_stdout
from pathlib import Path
import sys

import numpy as np


class Engine:
    chunk_frames = 20
    fps = 25
    _context_frames = 60
    _left_samples = 2000  # Hubert's three frames plus convolution margin.

    def __init__(self, config):
        self.config = dict(config)
        self.sdk = None
        self.source_info = None
        self._silent_features = None

    def _load_sdk(self):
        root = Path(self.config["root"])
        weights = Path(self.config["weights"])
        if not root.is_absolute() or not weights.is_absolute():
            raise ValueError("Ditto root and weights must be absolute paths")
        sys.path.insert(0, str(root))
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("Ditto requires an available NVIDIA CUDA GPU")
        # ONNX Runtime needs PyTorch's CUDA/cuDNN libraries loaded first.
        import onnxruntime
        if hasattr(onnxruntime, "preload_dlls"):
            onnxruntime.preload_dlls()
        from stream_pipeline_online import StreamSDK
        cfg = self.config.get("cfg", str(weights.parent / "ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"))
        return StreamSDK(cfg, str(weights))

    def start(self, source):
        path = Path(source)
        if not path.is_absolute() or not path.is_file():
            raise ValueError("Ditto source must be an existing absolute image path")
        with redirect_stdout(sys.stderr):
            if self.sdk is None:
                self.sdk = self._load_sdk()
            self.source_info = self.sdk.avatar_registrar(
                str(path), max_dim=int(self.config.get("max_size", 1920)), n_frames=1,
                crop_scale=2.3, crop_vx_ratio=0, crop_vy_ratio=-0.125,
                crop_flag_do_rot=True,
            )
            if not self.source_info["is_image_flag"] or len(self.source_info["x_s_info_lst"]) != 1:
                raise ValueError("Ditto requires one PNG or JPEG reference image")
            self.reset()

    def reset(self):
        if self.sdk is None or self.source_info is None:
            return
        with redirect_stdout(sys.stderr):
            sdk = self.sdk
            defaults = sdk.default_kwargs
            # The released canonical driving template normalizes motion scale;
            # replacing it with this texture's geometry suppresses articulation.
            canonical = defaults.get("ch_info")
            sdk.condition_handler.setup(self.source_info, 4, eye_f0_mode=False, ch_info=canonical)
            sdk.audio2motion.setup(
                sdk.condition_handler.x_s_info_0,
                overlap_v2=self._context_frames, online_mode=True,
                sampling_timesteps=int(self.config.get("sampling_timesteps", 50)),
                fix_kp_cond=defaults.get("fix_kp_cond", 0),
                fix_kp_cond_dim=defaults.get("fix_kp_cond_dim"),
                v_min_max_for_clip=defaults.get("v_min_max_for_clip"),
                smo_k_d=defaults.get("smo_k_d", 3),
            )
            sdk.motion_stitch.setup(
                N_d=-1, relative_d=True, is_image_flag=True,
                x_s_info=self.source_info["x_s_info_lst"][0], d0=None,
                flag_stitching=True,
                ch_info=canonical,
                delta_eye_arr=defaults.get("delta_eye_arr"),
                delta_eye_open_n=defaults.get("delta_eye_open_n", 0),
                overall_ctrl_info=defaults.get("overall_ctrl_info"),
            )
            if self._silent_features is None:
                self._silent_features = sdk.wav2feat.wav2feat(
                    np.zeros(self._context_frames * 640, np.float32), sr=16000,
                )
            self._features = self._silent_features.copy()
            self._audio_history = np.zeros(self._left_samples, np.float32)
            self._motion = None
            self._frame_index = 0

    def render(self, audio):
        if self.sdk is None or self.source_info is None:
            raise RuntimeError("Ditto engine is not started")
        audio = np.asarray(audio)
        if (audio.dtype != np.float32 or audio.ndim != 1
                or audio.size != self.chunk_frames * 640 or not np.isfinite(audio).all()):
            raise ValueError("Ditto requires exactly 12800 finite float32 mono samples at 16000 Hz")
        with redirect_stdout(sys.stderr):
            sdk = self.sdk
            padded = np.concatenate((self._audio_history, audio, np.zeros(1280, np.float32)))
            # Four Hubert windows each produce five correctly centered frames.
            features = np.concatenate([
                sdk.wav2feat(padded[i:i + 6480], chunksize=(3, 5, 2))
                for i in range(0, audio.size, 3200)
            ])
            if features.shape[0] != self.chunk_frames:
                raise RuntimeError("Ditto Hubert returned an unexpected frame count")
            self._audio_history = audio[-self._left_samples:].copy()
            window = np.concatenate((self._features, features))
            cond = sdk.condition_handler(window, self._frame_index - self._context_frames)[None]
            motion = sdk.audio2motion(cond, self._motion)
            self._motion = motion[:, -80:].copy()
            self._features = window[-self._context_frames:].copy()
            current = sdk.audio2motion.cvt_fmt(motion[:, -self.chunk_frames:])
            if len(current) != self.chunk_frames:
                raise RuntimeError("Ditto diffusion returned an unexpected frame count")
            frames = []
            source = self.source_info
            for driving in current:
                x_s, x_d = sdk.motion_stitch(source["x_s_info_lst"][0], driving)
                feature = sdk.warp_f3d(source["f_s_lst"][0], x_s, x_d)
                image = sdk.decode_f3d(feature)
                frame = sdk.putback(source["img_rgb_lst"][0], image, source["M_c2o_lst"][0])
                frames.append(np.ascontiguousarray(frame, dtype=np.uint8).copy())
            self._frame_index += self.chunk_frames
            return frames

    def close(self):
        # StreamSDK.setup was not used, so no writer threads need joining.
        self.source_info = None
        self.sdk = None
        self._motion = None
        self._features = None
        self._audio_history = None
        self._silent_features = None
