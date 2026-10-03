import unittest

import cv2
import numpy as np

from avatars.musetalk.textured_blending import TexturedMouthBlender


class TexturedMouthBlenderTest(unittest.TestCase):
    def test_moves_generated_mouth_to_static_lip_position_and_preserves_outer_texture(self):
        source = np.full((200, 200, 3), 100, dtype=np.uint8)
        source[30:60, 30:60] = (20, 40, 60)
        face = np.full((160, 160, 3), 100, dtype=np.uint8)
        face[88:94, 78:84] = (0, 0, 255)  # mouth centered at (101, 111)
        blender = TexturedMouthBlender(
            source,
            (20, 20, 180, 180),
            {"center": [101, 101], "radius": [40, 30], "shift": [0, -10], "detail_strength": 0},
        )

        output = blender.blend(face)

        self.assertGreater(int(output[101, 101, 2]), 240)
        np.testing.assert_array_equal(output[40, 40], source[40, 40])
        np.testing.assert_array_equal(output[160, 160], source[160, 160])

    def test_restores_source_skin_detail_in_blended_region(self):
        yy, xx = np.indices((200, 200))
        pattern = np.where((xx + yy) % 2 == 0, 115, 85).astype(np.uint8)
        source = np.repeat(pattern[:, :, None], 3, axis=2)
        face = np.full((160, 160, 3), 100, dtype=np.uint8)
        settings = {"center": [100, 100], "radius": [60, 45], "shift": [0, 0], "detail_strength": 0.9}

        output = TexturedMouthBlender(source, (20, 20, 180, 180), settings).blend(face)
        plain = TexturedMouthBlender(source, (20, 20, 180, 180), {**settings, "detail_strength": 0}).blend(face)

        self.assertGreater(float(output[75:85, 75:85, 0].std()), 5)
        self.assertLess(float(plain[75:85, 75:85, 0].std()), 1)

    def test_mouth_open_scale_moves_generated_lips_toward_the_static_center(self):
        source = np.full((200, 200, 3), 100, dtype=np.uint8)
        face = np.full((160, 160, 3), 100, dtype=np.uint8)
        face[69:72, 80] = (0, 0, 255)  # upper lip at image y=90
        face[89:92, 80] = (255, 0, 0)  # lower lip at image y=110
        blender = TexturedMouthBlender(
            source,
            (20, 20, 180, 180),
            {
                "center": [100, 100],
                "radius": [40, 70],
                "shift": [0, 0],
                "detail_strength": 0,
                "mouth_open_scale": 0.5,
            },
        )

        output = blender.blend(face)

        self.assertGreater(int(output[95, 100, 2]), 240)
        self.assertGreater(int(output[105, 100, 0]), 240)
        np.testing.assert_array_equal(output[90, 100], source[90, 100])
        np.testing.assert_array_equal(output[110, 100], source[110, 100])


if __name__ == "__main__":
    unittest.main()
