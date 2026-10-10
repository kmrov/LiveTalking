"""AVTR-1 portrait renderer inside its isolated Python 3.12 worker."""
import os
from pathlib import Path
import shutil
import tempfile

import cv2
import numpy as np


class Engine:
    fps = 25
    chunk_frames = 5
    chunk_samples = 3200
    future_samples = 3280

    def __init__(self, config):
        self.config = dict(config)
        self.pipeline = None
        self.avatar = None
        self.state = None
        self._reference_dir = None

    def _load_pipeline(self, portrait_dir, size):
        from avtr1_renderer.pipeline import Pipeline
        return Pipeline.from_artifacts(
            avatar_ids=['studio'], portraits_dir=portrait_dir, out_size=size,
        )

    def start(self, source):
        if self.pipeline is not None:
            raise RuntimeError('AVTR-1 engine is already started.')
        source = Path(source)
        if not source.is_absolute() or not source.is_file() or source.suffix.lower() not in ('.png', '.jpg', '.jpeg'):
            raise ValueError('AVTR-1 requires one absolute PNG/JPEG portrait.')
        original = cv2.imread(str(source), cv2.IMREAD_UNCHANGED)
        if original is None:
            raise ValueError('Could not load AVTR-1 portrait.')
        height, width = original.shape[:2]
        # Match the source aspect ratio. The upstream 1280x720 default would
        # distort Studio's square portraits and use more GPU memory.
        output_size = int(self.config.get('output_size', 768))
        if not 256 <= output_size <= 1280:
            raise ValueError('AVTR-1 output_size must be 256–1280 pixels.')
        scale = min(1.0, output_size / max(height, width))
        out_h = max(2, int(height * scale) // 2 * 2)
        out_w = max(2, int(width * scale) // 2 * 2)
        self._reference_dir = tempfile.TemporaryDirectory(prefix='studio-avtr1-')
        portrait_dir = Path(self._reference_dir.name)
        shutil.copyfile(source, portrait_dir / 'studio.png')
        os.environ['AVTR1_LOCAL_STORAGE'] = str(Path(self.config['weights']).resolve().parent)
        try:
            self.pipeline, registry = self._load_pipeline(portrait_dir, (out_h, out_w))
            self.avatar = registry['studio']
        except BaseException:
            self.close()
            raise
        self.state = None

    def render(self, audio, *, future=None, listen=None):
        if self.pipeline is None:
            raise RuntimeError('AVTR-1 engine is not started.')
        audio = np.asarray(audio, dtype=np.float32)
        future = np.zeros(self.future_samples, np.float32) if future is None else np.asarray(future, dtype=np.float32)
        listen = np.zeros(self.chunk_samples + self.future_samples, np.float32) if listen is None else np.asarray(listen, dtype=np.float32)
        if (audio.shape != (self.chunk_samples,) or future.shape != (self.future_samples,)
                or listen.shape != (self.chunk_samples + self.future_samples,)
                or not all(np.isfinite(part).all() for part in (audio, future, listen))):
            raise ValueError('Invalid AVTR-1 speech or listening window.')
        from avtr1_renderer.pipeline import TRANSPARENT_BG_ID
        from avtr1_renderer.types import Chunk, RenderOptions
        chunk = Chunk(audio_speech=np.concatenate((audio, future)), audio_listen=listen)
        options = RenderOptions(pixel_format='yuv_i420', bg_id=TRANSPARENT_BG_ID)
        self.state, frames = self.pipeline.process_chunk(self.avatar, chunk, self.state, options)
        for frame in frames:
            rgb = cv2.cvtColor(frame.data, cv2.COLOR_YUV2RGB_I420)
            yield np.ascontiguousarray(rgb)

    def reset(self):
        self.state = None

    def close(self):
        self.state = None
        self.avatar = None
        self.pipeline = None
        if self._reference_dir is not None:
            self._reference_dir.cleanup()
            self._reference_dir = None
