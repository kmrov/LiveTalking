"""Lightweight eyelid and eyebrow motion for a single-frame face texture."""

import math

import cv2
import numpy as np


class TextureExpressionAnimator:
    def __init__(self, frame_shape, settings):
        height, width = frame_shape[:2]
        self.frame_shape = tuple(frame_shape)
        self.fps = float(settings.get("fps", 25))
        self.eyelid_motion_enabled = bool(settings.get("eyelid_motion_enabled", True))
        self.blink_displacement = float(settings.get("blink_displacement", 16))
        self.brow_raise = float(settings.get("brow_raise", 3))
        self.eyes = [self._make_region(spec, width, height) for spec in settings["eyes"]]
        self.brows = [self._make_region(spec, width, height) for spec in settings.get("brows", [])]
        self.frame_index = 0
        self.blink_starts = [2.2]

    @staticmethod
    def _make_region(spec, width, height):
        cx, cy, rx, ry = map(float, spec)
        if rx <= 0 or ry <= 0:
            raise ValueError("eye and brow radii must be positive")
        x1 = max(0, math.floor(cx - rx))
        y1 = max(0, math.floor(cy - ry))
        x2 = min(width, math.ceil(cx + rx) + 1)
        y2 = min(height, math.ceil(cy + ry) + 1)
        if x1 >= x2 or y1 >= y2:
            raise ValueError("eye or brow area falls outside the frame")
        yy, xx = np.mgrid[y1:y2, x1:x2].astype(np.float32)
        return (x1, y1, x2, y2, xx, yy, cx, cy, rx, ry)

    def blink_amount(self, seconds):
        duration = 0.24
        while seconds >= self.blink_starts[-1] + duration:
            index = len(self.blink_starts)
            interval = 3.4 + 0.8 * (1 + math.sin(index * 2.399))
            self.blink_starts.append(self.blink_starts[-1] + interval)
        phase = (seconds - self.blink_starts[-1]) / duration
        return max(0.0, math.sin(math.pi * phase)) if 0 <= phase <= 1 else 0.0

    @staticmethod
    def _replace_region(result, source, region, map_y, weight):
        x1, y1, x2, y2, xx, yy, *_ = region
        original = source[y1:y2, x1:x2]
        moved = cv2.remap(source, xx, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        result[y1:y2, x1:x2] = np.clip(
            moved.astype(np.float32) * weight[..., None]
            + original.astype(np.float32) * (1 - weight[..., None]), 0, 255
        ).astype(np.uint8)

    def render(self, frame, *, blink=0.0, brow=0.0):
        if frame.shape != self.frame_shape:
            raise ValueError("frame size differs from configured texture")
        blink = float(np.clip(blink, 0, 1))
        brow = float(np.clip(brow, 0, 1))
        if blink == 0 and brow == 0:
            return frame.copy()

        result = frame.copy()
        if brow:
            for index, region in enumerate(self.brows):
                x1, y1, x2, y2, xx, yy, cx, cy, rx, ry = region
                distance = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
                weight = np.clip((1 - distance) / 0.35, 0, 1)
                shift = self.brow_raise * brow * (1 if index == 0 else 0.8)
                self._replace_region(result, result, region, yy + shift * weight, weight)

        if blink:
            for region in self.eyes:
                x1, y1, x2, y2, xx, yy, cx, cy, rx, ry = region
                horizontal = np.clip((1 - (np.abs(xx - cx) / rx) ** 4) / 0.35, 0, 1)
                lid_center = cy + 8 * ((xx - cx) / rx) ** 2
                vertical = np.clip((ry - np.abs(yy - lid_center)) / (ry * 0.4), 0, 1)
                weight = horizontal * vertical
                displacement = (self.blink_displacement * blink * weight
                                * np.tanh((yy - lid_center) / 1.3))
                self._replace_region(result, result, region, yy + displacement, weight)
        return result

    def animate(self, frame, speaking=False):
        seconds = self.frame_index / self.fps
        self.frame_index += 1
        if self.eyelid_motion_enabled:
            blink = self.blink_amount(seconds)
            squint = 0.10 * max(0, math.sin(seconds * 0.55 + 1.3)) ** 2
        else:
            blink = squint = 0.0
        brow = (0.12 if speaking else 0) + 0.7 * max(0, math.sin(seconds * 0.7)) ** 2
        return self.render(frame, blink=min(1, blink + squint), brow=min(1, brow))
