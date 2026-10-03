"""Paste a generated mouth into a detailed, single-frame avatar texture."""

import cv2
import numpy as np


class TexturedMouthBlender:
    def __init__(self, original, face_box, settings):
        self.original = original
        self.face_box = tuple(map(int, face_box))
        self.shift = tuple(map(int, settings["shift"]))
        self.detail_strength = float(settings.get("detail_strength", 0.0))
        self.mouth_open_scale = float(settings.get("mouth_open_scale", 1.0))
        if self.mouth_open_scale < 0.5:
            raise ValueError("mouth_open_scale must be at least 0.5")

        x1, y1, x2, y2 = self.face_box
        center_x, center_y = settings["center"]
        radius_x, radius_y = settings["radius"]
        if radius_x <= 0 or radius_y <= 0:
            raise ValueError("mouth blend radii must be positive")

        blend_x1 = max(x1, int(np.floor(center_x - radius_x)))
        blend_y1 = max(y1, int(np.floor(center_y - radius_y)))
        blend_x2 = min(x2, int(np.ceil(center_x + radius_x)) + 1)
        blend_y2 = min(y2, int(np.ceil(center_y + radius_y)) + 1)
        if blend_x1 >= blend_x2 or blend_y1 >= blend_y2:
            raise ValueError("mouth blend area falls outside the avatar face box")
        self.blend_box = blend_x1, blend_y1, blend_x2, blend_y2

        dx, dy = self.shift
        sample_x1, sample_y1 = blend_x1 - x1 - dx, blend_y1 - y1 - dy
        sample_x2 = sample_x1 + blend_x2 - blend_x1
        sample_y2 = sample_y1 + blend_y2 - blend_y1
        if sample_x1 < 0 or sample_y1 < 0 or sample_x2 > x2 - x1 or sample_y2 > y2 - y1:
            raise ValueError("shifted mouth area falls outside the generated face")
        self.sample_box = sample_x1, sample_y1, sample_x2, sample_y2

        self.remap_x = None
        self.remap_y = None
        if self.mouth_open_scale != 1.0:
            yy, xx = np.mgrid[blend_y1:blend_y2, blend_x1:blend_x2]
            self.remap_x = (xx - x1 - dx).astype(np.float32)
            relative_y = yy - center_y
            horizontal_weight = np.clip(
                1 - (np.abs(xx - center_x) / radius_x) ** 4, 0, 1
            )
            displacement = ((1 / self.mouth_open_scale - 1) * radius_y / np.pi
                            * np.sin(np.pi * relative_y / radius_y) * horizontal_weight)
            self.remap_y = (yy - y1 - dy + displacement).astype(np.float32)
            if self.remap_y.min() < 0 or self.remap_y.max() >= y2 - y1:
                raise ValueError("scaled mouth area falls outside the generated face")

        self.source = original[blend_y1:blend_y2, blend_x1:blend_x2].astype(np.float32)
        yy, xx = np.ogrid[blend_y1:blend_y2, blend_x1:blend_x2]
        distance = np.sqrt(((xx - center_x) / radius_x) ** 2
                           + ((yy - center_y) / radius_y) ** 2)
        self.alpha = np.clip((1 - distance) / 0.25, 0, 1).astype(np.float32)[..., None]

        blurred = cv2.GaussianBlur(self.source, (0, 0), 4.5)
        detail = np.clip(self.source - blurred, -20, 20)
        inner_distance = np.sqrt(((xx - center_x) / (radius_x * 0.69)) ** 2
                                 + ((yy - center_y) / (radius_y * 0.48)) ** 2)
        inner_mouth = np.clip((1 - inner_distance) / 0.3, 0, 1).astype(np.float32)[..., None]
        self.detail = detail * self.detail_strength * (1 - 0.65 * inner_mouth)

    def blend(self, generated_face):
        x1, y1, x2, y2 = self.face_box
        width, height = x2 - x1, y2 - y1
        if generated_face.shape[:2] != (height, width):
            raise ValueError("generated face size does not match the avatar face box")

        if self.remap_x is None:
            sx1, sy1, sx2, sy2 = self.sample_box
            generated_mouth = generated_face[sy1:sy2, sx1:sx2].astype(np.float32)
        else:
            generated_mouth = cv2.remap(
                generated_face, self.remap_x, self.remap_y, cv2.INTER_LINEAR
            ).astype(np.float32)
        textured = np.clip(generated_mouth + self.detail, 0, 255)
        result = self.original.copy()
        bx1, by1, bx2, by2 = self.blend_box
        result[by1:by2, bx1:bx2] = np.clip(
            textured * self.alpha + self.source * (1 - self.alpha), 0, 255
        ).astype(np.uint8)
        return result
