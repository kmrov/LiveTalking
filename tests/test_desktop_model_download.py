import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server.desktop_model_download import download_file, model_download_plan, DownloadCancelled


class DesktopModelDownloadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = b'checked model weights'
        self.spec = dict(repo='ByteDance/LatentSync', revision='a'*40, file='auxiliary/test.pth', size=len(self.content), algorithm='sha256', digest=hashlib.sha256(self.content).hexdigest())

    def test_complete_verified_file_is_published_and_reused_without_network(self):
        progress = []
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_args, **_kwargs: io.BytesIO(self.content), emit=progress.append)
        self.assertEqual(target.read_bytes(), self.content)
        self.assertEqual(progress[-1]['downloadedBytes'], len(self.content))
        download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_args, **_kwargs: self.fail('A present file must be reused'))
        self.assertFalse(list(target.parent.glob('*.part')))

    def test_wrong_checksum_is_discarded_without_publishing_a_model(self):
        with self.assertRaises(ValueError):
            download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_args, **_kwargs: io.BytesIO(b'x'*len(self.content)))
        self.assertFalse((self.root/'models/test.pth').exists())
        self.assertFalse(list((self.root/'models').glob('*.part')))

    def test_truncated_download_is_preserved_without_publishing_a_model(self):
        with self.assertRaises(ValueError):
            download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_args, **_kwargs: io.BytesIO(self.content[:-1]))
        self.assertFalse((self.root/'models/test.pth').exists())
        partials=list((self.root/'models').glob('*.part'))
        self.assertEqual(len(partials),1)
        self.assertEqual(partials[0].read_bytes(),self.content[:-1])

    def test_cancel_preserves_a_complete_file_and_repeat_installs_without_network(self):
        cancelled = False
        def progress(_event):
            nonlocal cancelled
            cancelled = True
        with self.assertRaises(DownloadCancelled):
            download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_args, **_kwargs: io.BytesIO(self.content), emit=progress, cancelled=lambda: cancelled)
        self.assertFalse((self.root/'models/test.pth').exists())
        self.assertEqual(len(list((self.root/'models').glob('*.part'))),1)
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_args, **_kwargs:self.fail('Complete partial must be verified locally'))
        self.assertEqual(target.read_bytes(), self.content)

    def test_path_escape_and_symlinked_parent_never_write_outside_the_model_root(self):
        outside = self.root/'outside'; outside.mkdir()
        (self.root/'models').symlink_to(outside, target_is_directory=True)
        for relative in ['../escape.pth', 'models/test.pth']:
            with self.assertRaises(ValueError):
                download_file(self.root, relative, self.spec, open_url=lambda *_args, **_kwargs: self.fail('An unsafe path must be refused before network access'))
        self.assertEqual(list(outside.iterdir()), [])

    def test_insufficient_space_prevents_network_and_preserves_other_models(self):
        model = self.root/'models/existing.pth'; model.parent.mkdir(); model.write_bytes(b'original')
        with patch('server.desktop_model_download.shutil.disk_usage',return_value=(100,100,0)):
            with self.assertRaises(OSError):
                download_file(self.root,'models/test.pth',self.spec,open_url=lambda *_args,**_kwargs:self.fail('No download when storage is full'))
        self.assertEqual(model.read_bytes(),b'original')

    def test_creation_downloads_only_its_avatar_weights_and_start_includes_local_qwen(self):
        hubs = dict(torch_hub=self.root/'torch', speech_hub=self.root/'speech')
        creation = model_download_plan(self.root,'wav2lip',scope='creation',speech_mode='local',**hubs)
        self.assertEqual([entry['relative'] for entry in creation],['checkpoints/s3fd-619a316812.pth'])
        local = model_download_plan(self.root,'wav2lip',scope='start',speech_mode='local',**hubs)
        self.assertTrue(any(entry['relative']=='models/wav2lip.pth' for entry in local))
        self.assertTrue(any(entry['repo']=='Qwen/Qwen3-ASR-0.6B' for entry in local))
        self.assertTrue(any(entry['repo']=='Qwen/Qwen3-TTS-12Hz-1.7B-Base' and entry['file']=='speech_tokenizer/model.safetensors' for entry in local))
        external = model_download_plan(self.root,'wav2lip',scope='start',speech_mode='external',**hubs)
        self.assertEqual([entry['relative'] for entry in external],['models/wav2lip.pth'])


    def test_speech_snapshot_is_advertised_only_after_all_verified_files_finish(self):
        from server.desktop_model_download import ensure_models
        from functools import partial
        base=self.root/'cache';revision='a'*40
        prefix='models--Qwen--test/snapshots/'+revision+'/'
        entries=[dict(self.spec,base=base,relative=prefix+name,storage='speech',label='Qwen',repo='Qwen/test') for name in ['config.json','model.safetensors']]
        request=dict(root=str(self.root),model='wav2lip',speechMode='local')
        reference=base/'models--Qwen--test/refs/main';reference.parent.mkdir(parents=True);reference.write_text('b'*40)
        responses=iter([self.content,self.content[:-1]])
        real_download=partial(download_file,open_url=lambda *_a,**_k:io.BytesIO(next(responses)))
        with patch('server.desktop_model_download.model_download_plan',return_value=entries),patch('server.desktop_model_download.download_file',side_effect=real_download):
            with self.assertRaises(ValueError):ensure_models(request,lambda _:None,scope='start')
        self.assertEqual(reference.read_text(),'b'*40)
        self.assertTrue((base/(prefix+'config.json')).is_file())
        self.assertFalse((base/(prefix+'model.safetensors')).exists())
        progress=[]
        real_download=partial(download_file,open_url=lambda *_a,**_k:io.BytesIO(self.content))
        with patch('server.desktop_model_download.model_download_plan',return_value=entries),patch('server.desktop_model_download.download_file',side_effect=real_download):
            ensure_models(request,progress.append,scope='start')
        self.assertEqual(reference.read_text(),revision)
        self.assertEqual(progress[-1]['progress'],100)
        self.assertEqual(progress[-1]['totalBytes'],len(self.content),'repeat reuses the first completed file')

    def test_ultralight_plan_includes_vocabulary_required_by_wav2vec2_processor(self):
        plan=model_download_plan(self.root,'ultralight',scope='start',speech_mode='external')
        destinations={entry['relative'] for entry in plan}
        self.assertIn('models/hubert-large-ls960-ft/vocab.json',destinations)

    def test_start_preserves_ready_bin_and_sharded_speech_revisions_when_avatar_weights_are_missing(self):
        import json
        hub=self.root/'speech';revision='b'*40
        for name in ['Qwen3-ASR-0.6B','Qwen3-TTS-12Hz-1.7B-Base']:
            folder=hub/('models--Qwen--'+name);snapshot=folder/'snapshots'/revision
            snapshot.mkdir(parents=True);(folder/'refs').mkdir();(folder/'refs/main').write_text(revision)
            for file in ['config.json','tokenizer_config.json','preprocessor_config.json','vocab.json','merges.txt']:(snapshot/file).write_text('{}')
            if 'ASR' in name:(snapshot/'pytorch_model.bin').write_bytes(b'weights')
            else:
                (snapshot/'model.safetensors.index.json').write_text(json.dumps({'weight_map':{'a':'one.safetensors','b':'two.safetensors'}}))
                for file in ['one.safetensors','two.safetensors']:(snapshot/file).write_bytes(b'weights')
                tokenizer=snapshot/'speech_tokenizer';tokenizer.mkdir()
                for file in ['config.json','preprocessor_config.json','pytorch_model.bin']:(tokenizer/file).write_bytes(b'data')
        plan=model_download_plan(self.root,'wav2lip',scope='start',speech_mode='local',speech_hub=hub)
        self.assertEqual([entry['relative'] for entry in plan],['models/wav2lip.pth'])
        for folder in hub.iterdir():self.assertEqual((folder/'refs/main').read_text(),revision)
