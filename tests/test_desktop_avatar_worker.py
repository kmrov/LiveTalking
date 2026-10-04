import json
import pickle
import tempfile
import unittest
import shutil,subprocess,sys
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from scripts.prepare_desktop_avatar import run_job, inspect_creation, validate_request, main

class DesktopAvatarWorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.source=self.root/'Фото.jpg';Image.new('RGB',(100,100)).save(self.source)
        self.request={'schemaVersion':1,'jobId':'a'*32,'avatarId':'studio_'+'b'*32,'root':str(self.root),'jobDir':str(self.root/'data/.studio-avatar-work'/('a'*32)),'sourceFile':str(self.source),'sourceKind':'image','name':'Персона','model':'musetalk','parameters':{}}
        self.request['sourceFingerprint']=self.fingerprint()
    def fingerprint(self):
        value=self.source.stat();return ':'.join(str(x) for x in (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns))
    def generate(self,**kwargs):
        folder=Path(kwargs['save_path'])/kwargs['avatar_id'];(folder/'full_imgs').mkdir(parents=True)
        Image.new('RGB',(100,100)).save(folder/'full_imgs/00000000.png')
        (folder/'coords.pkl').write_bytes(pickle.dumps([(0,0,50,50)] if self.request['model']=='musetalk' else [(0,50,0,50)]))
        if self.request['model']=='musetalk':
            import torch
            (folder/'mask').mkdir();Image.new('L',(100,100)).save(folder/'mask/00000000.png')
            (folder/'mask_coords.pkl').write_bytes(pickle.dumps([(0,0,50,50)]))
            torch.save([torch.ones(1,8,32,32)],folder/'latents.pt')
            self.assertEqual(Path(kwargs['video_path']).name,'00000000.png')
        else:
            self.assertEqual(kwargs['img_size'],256);(folder/'face_imgs').mkdir()
            Image.new('RGB',(256,256)).save(folder/'face_imgs/00000000.png')
        kwargs['progress_callback'](50)
    def test_worker_prepares_own_source_and_thumbnail_with_versioned_progress(self):
        events=[]
        with patch('scripts.prepare_desktop_avatar.inspect_creation',return_value=[]):
            result=run_job(self.request,events.append,generator_loader=lambda _:self.generate)
        self.assertEqual(events[-1]['state'],'prepared');self.assertEqual(result['frameCount'],1)
        self.assertTrue(all(e['version']==1 and e['jobId']==self.request['jobId'] for e in events))
        self.assertTrue((Path(self.request['jobDir'])/'source/input.jpg').exists())
        thumbnail=Path(self.request['jobDir'])/'output'/self.request['avatarId']/'thumbnail.jpg'
        with Image.open(thumbnail) as image:self.assertLessEqual(max(image.size),256)
        self.source.unlink();self.assertTrue(thumbnail.exists())
    def test_wav2lip_uses_current_server_resolution(self):
        self.source=self.root/'input.mp4';self.source.write_bytes(b'video')
        self.request.update(sourceFile=str(self.source),sourceKind='video',model='wav2lip')
        self.request['sourceFingerprint']=self.fingerprint()
        with patch('scripts.prepare_desktop_avatar.inspect_creation',return_value=[]),patch('scripts.prepare_desktop_avatar.normalize_media',return_value=self.source):
            self.assertEqual(run_job(self.request,lambda _:None,generator_loader=lambda _:self.generate)['frameCount'],1)
    def test_bad_result_and_one_missing_face_never_report_prepared(self):
        for invalid in ('mask','coords'):
            self.request['jobId'] = ('c' if invalid=='mask' else 'd')*32
            self.request['jobDir'] = str(self.root/'data/.studio-avatar-work'/self.request['jobId'])
            events=[]
            def bad(**kwargs):
                self.generate(**kwargs);folder=Path(kwargs['save_path'])/kwargs['avatar_id']
                if invalid=='mask':(folder/'mask/00000000.png').unlink()
                else:(folder/'coords.pkl').write_bytes(pickle.dumps([(0,0,0,0)]))
            with patch('scripts.prepare_desktop_avatar.inspect_creation',return_value=[]):
                with self.assertRaises(ValueError):run_job(self.request,events.append,generator_loader=lambda _:bad)
            self.assertFalse(any(e['state']=='prepared' for e in events))
    def test_request_rejects_escape_unknown_model_and_bad_parameters(self):
        for changes in ({'jobDir':str(self.root.parent)}, {'avatarId':'../escape'}, {'model':'ultralight'}, {'parameters':{'bbox_shift':51}}, {'parameters':{'nosmooth':'false'}}):
            with self.assertRaises(ValueError):validate_request({**self.request,**changes})
    def test_missing_dependencies_do_not_download_or_require_voice(self):
        with patch('torch.cuda.is_available',return_value=False):results=inspect_creation(self.request)
        self.assertTrue(any(x['id']=='gpu' and x['state']=='missing' for x in results))
        self.assertTrue(any(x['id']=='weights' and x['state']=='missing' for x in results))
        self.assertFalse(any(x['id'] in ('voice','asr','tts','brain','avatar') for x in results))
    def test_cli_invalid_job_exits_failed_with_protocol_message(self):
        file=self.root/'job.json';file.write_text(json.dumps({**self.request,'avatarId':'../bad'}))
        from io import StringIO
        out=StringIO()
        with patch('sys.stdout',out):code=main(['--job',str(file)])
        self.assertNotEqual(code,0);self.assertIn('LT_AVATAR ',out.getvalue());self.assertIn('failed',out.getvalue())
    def test_source_replaced_during_probe_is_rejected_before_copying(self):
        def probe(request):
            self.source.rename(self.source.with_suffix('.old'));Image.new('RGB',(100,100),'blue').save(self.source)
            return []
        with patch('scripts.prepare_desktop_avatar.inspect_creation',side_effect=probe):
            with self.assertRaisesRegex(ValueError,'again'):
                run_job(self.request,lambda _:None,generator_loader=lambda _:self.generate)
        self.assertFalse((Path(self.request['jobDir'])/'source/input.jpg').exists())
    def test_missing_weights_are_downloaded_after_saving_source_then_generation_continues(self):
        checks=[{'id':'weights','state':'missing','detail':'Missing weights','action':''}]
        events=[]
        def prepare(_request,emit):
            self.assertTrue((Path(self.request['jobDir'])/'source/input.jpg').exists())
            emit({'file':'s3fd.pth','downloadedBytes':5,'totalBytes':10,'progress':50})
        with patch('scripts.prepare_desktop_avatar.inspect_creation',side_effect=[checks,[]]),patch('scripts.prepare_desktop_avatar.ensure_creation_models',side_effect=prepare,create=True):
            run_job(self.request,events.append,generator_loader=lambda _:self.generate)
        self.assertTrue(any(event['stage']=='downloading' and event.get('downloadedBytes')==5 for event in events))
        self.assertEqual(events[-1]['state'],'prepared')
    def test_source_changed_during_copy_is_rejected_without_committing_a_copy(self):
        import shutil
        copy=shutil.copyfileobj
        def changing_copy(source,destination,*args,**kwargs):
            copy(source,destination,*args,**kwargs);self.source.write_bytes(b'changed during copy')
        with patch('scripts.prepare_desktop_avatar.inspect_creation',return_value=[]),patch('scripts.prepare_desktop_avatar.shutil.copyfileobj',side_effect=changing_copy):
            with self.assertRaisesRegex(ValueError,'again'):
                run_job(self.request,lambda _:None,generator_loader=lambda _:self.generate)
        self.assertFalse((Path(self.request['jobDir'])/'source/input.jpg').exists())
    @unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg unavailable')
    def test_real_video_preview_fits_the_subprocess_resource_budget(self):
        video=self.root/'Короткое видео.mp4'
        subprocess.run(['ffmpeg','-v','error','-loop','1','-i',str(self.source),'-t','0.12','-threads','1','-pix_fmt','yuv420p',str(video)],check=True)
        request=self.root/'preview.json';request.write_text(json.dumps({'sourceKind':'video','sourceFile':str(video)}))
        result=subprocess.run([sys.executable,str(Path(inspect_creation.__code__.co_filename).resolve()),'--preview',str(request)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        with Image.open(self.root/'preview.jpg') as image:self.assertLessEqual(max(image.size),256)

    def test_packaged_musetalk_detector_import(self):
        import sys
        from types import ModuleType
        from avatars.musetalk.utils.face_detection.api import FaceAlignment, LandmarksType
        module=ModuleType('avatars.musetalk.utils.face_detection.detection.sfd')
        module.FaceDetector=lambda **kwargs:kwargs
        with patch.dict(sys.modules,{module.__name__:module}):
            detector=FaceAlignment(LandmarksType._2D,device='cpu')
        self.assertEqual(detector.face_detector['device'],'cpu')

    def test_real_wav2lip_generator_rejects_frame_without_face(self):
        from avatars.wav2lip import genavatar
        class Detector:
            def get_detections_for_batch(self,images):return [None]*len(images)
        def frames(video,folder,**kwargs):
            Image.new('RGB',(100,100)).save(Path(folder)/'00000000.png')
        with patch.object(genavatar,'video2imgs',side_effect=frames),patch.object(genavatar.face_detection,'FaceAlignment',return_value=Detector()):
            with self.assertRaisesRegex(ValueError,'Face not found'):
                genavatar.generate_avatar('unused','no_face',save_path=str(self.root))
        self.assertFalse((self.root/'no_face/coords.pkl').exists())

    def test_reference_engines_prepare_without_gpu_weights_or_generator(self):
        (self.root/'app.py').touch();(self.root/'avatars').mkdir()
        for index,model in enumerate(('ditto','soulx')):
            request={**self.request,'model':model,'jobId':str(index)*32,'jobDir':str(self.root/'data/.studio-avatar-work'/(str(index)*32))}
            with patch('scripts.prepare_desktop_avatar.detector_file',side_effect=AssertionError('detector used')),patch('scripts.prepare_desktop_avatar.ensure_creation_models',side_effect=AssertionError('download used')),patch('scripts.prepare_desktop_avatar.local_generator',side_effect=AssertionError('generator used')):
                checks=inspect_creation(request)
                self.assertTrue(all(x['state']=='ready' for x in checks),checks)
                self.assertFalse(any(x['id'] in ('gpu','weights') for x in checks))
                result=run_job(request,lambda _:None)
            avatar=Path(request['jobDir'])/'output'/request['avatarId']
            self.assertEqual(result['frameCount'],1)
            self.assertEqual(json.loads((avatar/'generative-avatar.json').read_text()),{'version':1,'model':model})
            self.assertFalse((avatar/'coords.pkl').exists())
            with Image.open(avatar/'full_imgs/00000000.png') as image:self.assertEqual(image.size,(100,100))
            self.assertTrue((avatar/'thumbnail.jpg').is_file())
            self.assertEqual((Path(request['jobDir'])/'source/input.jpg').read_bytes(),self.source.read_bytes())
            for changes in ({'sourceKind':'video'},{'parameters':{'bbox_shift':0}}):
                with self.assertRaises(ValueError):validate_request({**request,**changes})
