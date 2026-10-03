import unittest

import numpy as np

from avatars.musetalk.texture_expression import TextureExpressionAnimator


class TextureExpressionAnimatorTest(unittest.TestCase):
    def setUp(self):
        self.frame = np.full((120, 180, 3), 160, dtype=np.uint8)
        self.frame[47:54, 48:72] = 20  # dark eye aperture
        self.settings = {
            "eyes": [[60, 50, 30, 18]],
            "brows": [[60, 30, 38, 12]],
            "blink_displacement": 12,
            "brow_raise": 3,
            "fps": 25,
        }

    def test_closed_eye_hides_aperture_and_keeps_other_texture(self):
        animator = TextureExpressionAnimator(self.frame.shape, self.settings)
        closed = animator.render(self.frame, blink=1, brow=0)

        self.assertGreater(float(closed[47:54, 48:72].mean()), 100)
        np.testing.assert_array_equal(closed[80:100, 20:40], self.frame[80:100, 20:40])
        np.testing.assert_array_equal(self.frame[47:54, 48:72], 20)

    def test_open_eye_is_unchanged_and_brow_motion_is_local(self):
        animator = TextureExpressionAnimator(self.frame.shape, self.settings)
        open_frame = animator.render(self.frame, blink=0, brow=0)
        np.testing.assert_array_equal(open_frame, self.frame)

        brow_frame = self.frame.copy()
        brow_frame[28:30, 50:70] = 40
        raised = animator.render(brow_frame, blink=0, brow=1)
        self.assertFalse(np.array_equal(raised[24:34, 50:70], brow_frame[24:34, 50:70]))
        np.testing.assert_array_equal(raised[45:55, 50:70], brow_frame[45:55, 50:70])

    def test_timed_blink_has_open_and_closed_frames(self):
        animator = TextureExpressionAnimator(self.frame.shape, self.settings)
        values = [animator.blink_amount(i / 25) for i in range(250)]
        self.assertEqual(values[0], 0)
        self.assertGreater(max(values), 0.95)
        self.assertGreater(sum(value == 0 for value in values), 200)

    def test_blink_runs_when_silent_or_speaking_without_changing_mouth(self):
        frame = self.frame.copy()
        frame[85:95, 70:110] = (12, 42, 220)
        for speaking in (False, True):
            animator = TextureExpressionAnimator(frame.shape, self.settings)
            animator.frame_index = 58  # peak of the first blink at 25 fps
            output = animator.animate(frame, speaking=speaking)
            self.assertGreater(float(output[47:54, 48:72].mean()), 100)
            np.testing.assert_array_equal(output[85:95, 70:110], frame[85:95, 70:110])

    def test_disabled_eyelid_motion_keeps_eye_pixels_still(self):
        settings = {**self.settings, "eyelid_motion_enabled": False, "brow_raise": 1.5}
        animator = TextureExpressionAnimator(self.frame.shape, settings)
        animator.frame_index = 58  # former blink peak
        output = animator.animate(self.frame)

        np.testing.assert_array_equal(output[45:55, 45:75], self.frame[45:55, 45:75])


if __name__ == "__main__":
    unittest.main()
