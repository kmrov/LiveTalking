import json
from pathlib import Path
import tempfile
import unittest

from scripts.setup_avtr1_engine import configure_runtime, REQUIRED_FILES


class SetupAvtr1Tests(unittest.TestCase):
    def test_configure_runtime_requires_complete_pixi_install_and_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            checkout = base / 'avtr-1'
            checkout.mkdir()
            (checkout / 'pixi.toml').write_text('[workspace]\n')
            python = checkout / '.pixi/envs/renderer/bin/python'
            python.parent.mkdir(parents=True)
            python.write_text('#!/bin/sh\n')
            python.chmod(0o755)
            weights = checkout / 'artifacts/main'
            weights.mkdir(parents=True)
            runtime = base / 'models/avtr1/runtime.json'
            with self.assertRaisesRegex(ValueError, 'missing'):
                configure_runtime(checkout, weights, runtime)
            self.assertFalse(runtime.exists())
            for name in REQUIRED_FILES:
                artifact = weights / name
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes(b'weight')
            with self.assertRaisesRegex(ValueError, 'backgrounds'):
                configure_runtime(checkout, weights, runtime)
            for name in ('backgrounds', 'reference_frames'):
                folder = weights / 'avatars_artifacts' / name
                folder.mkdir(parents=True)
                (folder / 'sample.png').write_bytes(b'png')
            config = configure_runtime(checkout, weights, runtime)
            self.assertEqual(config['python'], str(python))
            self.assertEqual(config['weights'], str(weights))
            self.assertIs(config['buffered_playback'], False)
            self.assertEqual(json.loads(runtime.read_text()), config)
            self.assertEqual(len(config['required_files']), len(REQUIRED_FILES))
            wrong_revision = checkout / 'artifacts/other'
            with self.assertRaisesRegex(ValueError, 'main'):
                configure_runtime(checkout, wrong_revision, runtime)


if __name__ == '__main__':
    unittest.main()
