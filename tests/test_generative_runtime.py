import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from server.generative_runtime import load_runtime


class RuntimeTests(unittest.TestCase):
    def test_avtr1_requires_pixi_runtime_and_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / 'avtr-1'
            checkout.mkdir()
            python = checkout / '.pixi/envs/renderer/bin/python'
            python.parent.mkdir(parents=True)
            python.write_text('#!/bin/sh\n')
            python.chmod(0o755)
            weights = checkout / 'artifacts/main'
            weights.mkdir(parents=True)
            engine = weights / 'speech2motion_runtime_artifacts_cc/avtr1_encode_fp16.engine'
            engine.parent.mkdir(parents=True)
            runtime = root / 'models/avtr1/runtime.json'
            runtime.parent.mkdir(parents=True)
            cfg = {'python': str(python), 'root': str(checkout), 'weights': str(weights),
                   'required_files': [str(engine)], 'probe_imports': ['avtr1_renderer']}
            runtime.write_text(json.dumps(cfg))
            with self.assertRaisesRegex(ValueError, 'weight|file'):
                load_runtime(root, 'avtr1')
            engine.write_bytes(b'engine')
            self.assertEqual(load_runtime(root, 'avtr1')['model'], 'avtr1')
            cfg['weights'] = str(checkout)
            runtime.write_text(json.dumps(cfg))
            with self.assertRaisesRegex(ValueError, 'main'):
                load_runtime(root, 'avtr1')
            cfg['weights'] = str(weights)
            cfg['python'] = sys.executable
            runtime.write_text(json.dumps(cfg))
            with self.assertRaisesRegex(ValueError, 'Pixi'):
                load_runtime(root, 'avtr1')

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
