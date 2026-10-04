import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from server.generative_runtime import load_runtime


class RuntimeTests(unittest.TestCase):
    def test_missing_and_empty_weights_are_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'models/ditto'
            folder.mkdir(parents=True)
            weight = root / 'weights.bin'
            cfg = {'python': sys.executable, 'root': str(root), 'weights': str(root),
                   'required_files': [str(weight)], 'probe_imports': ['json']}
            (folder / 'runtime.json').write_text(json.dumps(cfg))
            for exists in (False, True):
                if exists:
                    weight.touch()
                with self.assertRaisesRegex(ValueError, 'weight|file'):
                    load_runtime(root, 'ditto')
            weight.write_bytes(b'weights')
            self.assertEqual(load_runtime(root, 'ditto')['model'], 'ditto')

    def test_invalid_model_and_relative_executable_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                load_runtime(directory, '../../bad')
            path = Path(directory) / 'models/soulx'
            path.mkdir(parents=True)
            (path / 'runtime.json').write_text(json.dumps({'python': 'python'}))
            with self.assertRaises(ValueError):
                load_runtime(directory, 'soulx')


if __name__ == '__main__':
    unittest.main()
