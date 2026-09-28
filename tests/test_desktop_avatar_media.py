import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from server.desktop_avatar_media import normalize_media, preview_media, validate_face_box, validate_generated_avatar, publish_directory

class DesktopAvatarMediaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
    def test_photo_orientation_and_numeric_name(self):
        image=Image.new('RGB',(30,20),'red');exif=image.getexif();exif[274]=6
        source=self.root/'Фото.jpg';image.save(source,exif=exif)
        result=normalize_media(source,'image',self.root/'input')
        self.assertEqual(result.name,'00000000.png')
        with Image.open(result) as value:self.assertEqual(value.size,(20,30))
        self.assertEqual(len(list(result.parent.iterdir())),1)
    def test_invalid_photo_and_face_box(self):
        source=self.root/'bad.png';source.write_bytes(b'invalid')
        with self.assertRaises(ValueError):normalize_media(source,'image',self.root/'input')
        for box in ((0,0,0,0),(-1,0,30,40),(0,0,400,40),(50,20,10,30)):
            with self.assertRaises(ValueError):validate_face_box(box,(100,100,3),'xyxy')
        self.assertEqual(validate_face_box((1,20,2,30),(100,100,3),'yxyx'),(1,20,2,30))
    def test_preview_rejects_excessive_pixel_dimensions_before_decoding(self):
        import struct, zlib
        source=self.root/'large.png';Image.new('RGB',(1,1)).save(source)
        data=bytearray(source.read_bytes());data[16:24]=struct.pack('>II',9000,9000)
        data[29:33]=struct.pack('>I',zlib.crc32(data[12:29]));source.write_bytes(data)
        with self.assertRaisesRegex(ValueError,'пиксел'):
            preview_media(source,'image',self.root/'thumbnail.jpg')
        self.assertFalse((self.root/'thumbnail.jpg').exists())
    def test_video_normalization_passes_one_path_and_25fps_without_audio(self):
        source=self.root/'Мой фильм.mov';source.write_bytes(b'video')
        calls=[]
        def run(args,**kwargs):
            calls.append((args,kwargs));Path(args[-1]).write_bytes(b'normalized')
            return type('Result',(),{'returncode':0,'stderr':''})()
        with patch('server.desktop_avatar_media.subprocess.run',side_effect=run):
            result=normalize_media(source,'video',self.root/'input')
        args,options=calls[0]
        self.assertEqual(args[args.index('-i')+1],str(source))
        self.assertIn('-an',args);self.assertEqual(args[args.index('-vf')+1],'fps=25')
        self.assertFalse(options.get('shell',False));self.assertEqual(result.parent,self.root/'input')
    def test_no_replace_publication_preserves_both_existing_kinds(self):
        for nonempty in (False,True):
            staged=self.root/('staged'+str(nonempty));staged.mkdir();(staged/'a').write_text('new')
            final=self.root/('final'+str(nonempty));final.mkdir()
            if nonempty:(final/'a').write_text('old')
            with self.assertRaises(FileExistsError):publish_directory(staged,final)
            self.assertTrue((staged/'a').exists())
            self.assertEqual((final/'a').read_text() if nonempty else list(final.iterdir()),'old' if nonempty else [])
        source=self.root/'valid';source.mkdir();(source/'a').write_text('ok')
        publish_directory(source,self.root/'published');self.assertFalse(source.exists())
        self.assertEqual((self.root/'published/a').read_text(),'ok')
    def test_generated_avatar_requires_consistent_coordinates_and_faces(self):
        import pickle
        folder=self.root/'avatar';(folder/'full_imgs').mkdir(parents=True);(folder/'face_imgs').mkdir()
        Image.new('RGB',(100,100)).save(folder/'full_imgs/00000000.png')
        Image.new('RGB',(256,256)).save(folder/'face_imgs/00000000.png')
        (folder/'coords.pkl').write_bytes(pickle.dumps([(0,50,0,50)]))
        self.assertEqual(validate_generated_avatar(folder,'wav2lip'),1)
        (folder/'coords.pkl').write_bytes(pickle.dumps([]))
        with self.assertRaises(ValueError):validate_generated_avatar(folder,'wav2lip')
    def test_symlink_in_generated_files_is_rejected_before_deserialization(self):
        folder=self.root/'avatar';folder.mkdir();outside=self.root/'outside';outside.write_text('bad')
        (folder/'coords.pkl').symlink_to(outside)
        with self.assertRaises(ValueError):validate_generated_avatar(folder,'wav2lip')
