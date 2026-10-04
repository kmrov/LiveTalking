import os
import tempfile
import unittest
import weakref

import numpy as np

from avatars.generative.audio_buffer import Packet
from avatars.generative.turn_buffer import TurnBuffer


class TurnBufferTests(unittest.TestCase):
    def buffer(self, **kwargs):
        buffer = TurnBuffer(**kwargs)
        self.addCleanup(buffer.close)
        return buffer

    def packets(self, index=0):
        return [Packet(np.linspace(-.9,.9,320,dtype=np.float32),0,{'status':'start','turn':index,'text':'Привет','nested':[True,None]}),
                Packet(np.zeros(320,np.float32),1,{'status':'end','turn':index})]

    def test_multiple_frames_preserve_pcm_events_geometry_and_bgr_colors(self):
        buffer=self.buffer()
        expected=[]
        for i in range(3):
            frame=np.full((48+i,64+i,3),(30+i,100+i,200+i),np.uint8)
            packets=self.packets(i)
            expected.append((frame.copy(),packets))
            buffer.append(frame,packets)
            frame[:]=0
        self.assertEqual(buffer.frames,3)
        for (frame,packets),(source,original) in zip(buffer.replay(),expected,strict=True):
            self.assertEqual(frame.shape,source.shape)
            self.assertLessEqual(np.abs(frame.astype(float)-source).max(),3)
            for actual,wanted in zip(packets,original,strict=True):
                np.testing.assert_array_equal(actual.data,wanted.data)
                self.assertEqual(actual.type,wanted.type)
                self.assertEqual(actual.userdata,wanted.userdata)
        self.assertEqual(len(list(buffer.replay())),3)

    def test_close_releases_disk_file_and_refuses_further_use(self):
        buffer=self.buffer()
        descriptor=buffer._file.fileno()
        buffer.close();buffer.close()
        with self.assertRaises(OSError):os.fstat(descriptor)
        with self.assertRaises(ValueError):buffer.append(np.zeros((8,8,3),np.uint8),self.packets())
        with self.assertRaises(ValueError):list(buffer.replay())

    def test_limit_refuses_append_without_corrupting_existing_frames(self):
        buffer=self.buffer(max_bytes=7000)
        frame=np.zeros((8,8,3),np.uint8)
        buffer.append(frame,self.packets())
        buffer.append(frame,self.packets())
        with self.assertRaisesRegex(ValueError,'limit'):buffer.append(frame,self.packets())
        self.assertEqual(buffer.frames,2)
        self.assertEqual(len(list(buffer.replay())),2)
        self.assertLessEqual(os.fstat(buffer._file.fileno()).st_size,7000)

    def test_keeps_frames_on_disk_without_retaining_input_arrays(self):
        buffer=self.buffer()
        refs=[]
        for _ in range(20):
            frame=np.zeros((128,128,3),np.uint8)
            packets=self.packets()
            refs.extend([weakref.ref(frame),weakref.ref(packets[0].data)])
            buffer.append(frame,packets)
        del frame,packets
        self.assertTrue(all(reference() is None for reference in refs))
        self.assertGreater(os.fstat(buffer._file.fileno()).st_size,20*2560)
        self.assertEqual(buffer.frames,20)

    def test_replay_rejects_truncated_or_malformed_internal_records(self):
        for corruption in ('truncate','header','metadata'):
            with self.subTest(corruption=corruption):
                buffer=self.buffer()
                buffer.append(np.zeros((8,8,3),np.uint8),self.packets())
                if corruption=='truncate':buffer._file.truncate(25)
                elif corruption=='header':buffer._file.seek(0);buffer._file.write(b'BAD!')
                else:
                    buffer._file.seek(-2561,os.SEEK_END);buffer._file.write(b'!')
                buffer._file.flush()
                with self.assertRaises(ValueError):list(buffer.replay())

    def test_invalid_frame_packet_or_non_json_metadata_never_adds_a_record(self):
        buffer=self.buffer();frame=np.zeros((8,8,3),np.uint8)
        for candidate,packets in [(frame.astype(float),self.packets()),(frame,self.packets()[:1]),
                (frame,[Packet(np.zeros(319,np.float32)),Packet(np.zeros(320,np.float32))]),
                (frame,[Packet(np.zeros(320,np.float32),2),Packet(np.zeros(320,np.float32))]),
                (frame,[Packet(np.zeros(320,np.float32),0,{1:'non-string-key'}),Packet(np.zeros(320,np.float32))])]:
            with self.assertRaises((ValueError,TypeError)):buffer.append(candidate,packets)
        self.assertEqual(buffer.frames,0)


if __name__=='__main__':unittest.main()
