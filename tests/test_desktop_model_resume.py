import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from server.desktop_model_download import DownloadCancelled, download_file


class Response(io.BytesIO):
    """The external HTTP boundary; files, hashing and publication stay real."""
    def __init__(self, content, *, status=200, headers=None, chunk_size=None, fail_after=None):
        super().__init__(content)
        self.status = status
        self.headers = headers or {}
        self.chunk_size = chunk_size
        self.fail_after = fail_after

    def read(self, size=-1):
        if self.fail_after is not None and self.tell() >= self.fail_after:
            raise ConnectionResetError('Connection lost')
        return super().read(min(size, self.chunk_size) if self.chunk_size else size)


class DesktopModelResumeTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.content = b'checked model weights'
        self.spec = dict(repo='ByteDance/LatentSync', revision='a'*40, file='auxiliary/test.pth', size=21, algorithm='sha256', digest=hashlib.sha256(self.content).hexdigest())

    def partial(self):
        files = list((self.root/'models').glob('*.part'))
        self.assertEqual(len(files), 1)
        return files[0]

    def cancel_after_first_chunk(self, size=7):
        stopped = False
        def emit(_event):
            nonlocal stopped
            stopped = True
        with self.assertRaises(DownloadCancelled):
            download_file(self.root, 'models/test.pth', self.spec,
                open_url=lambda *_a, **_k: Response(self.content, chunk_size=size),
                emit=emit, cancelled=lambda: stopped)
        self.assertFalse((self.root/'models/test.pth').exists())

    def test_cancel_preserves_bytes_and_repeat_requests_only_the_remainder(self):
        self.cancel_after_first_chunk()
        self.assertEqual(self.partial().read_bytes(), b'checked')
        progress = []
        def resume(request, **_kwargs):
            self.assertEqual(request.get_header('Range'), 'bytes=7-')
            return Response(b' model weights', status=206, headers={'Content-Range': 'bytes 7-20/21'})
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=resume, emit=progress.append)
        self.assertEqual(target.read_bytes(), self.content)
        self.assertEqual(progress[0]['downloadedBytes'], 7)
        self.assertEqual(progress[-1]['progress'], 100)
        self.assertFalse(list(target.parent.glob('*.part')))

    def test_network_failure_preserves_received_prefix_for_a_new_attempt(self):
        with self.assertRaises(ConnectionResetError):
            download_file(self.root, 'models/test.pth', self.spec,
                open_url=lambda *_a, **_k: Response(self.content, chunk_size=7, fail_after=7))
        self.assertEqual(self.partial().read_bytes(), b'checked')

    def test_server_ignoring_range_replaces_partial_instead_of_appending(self):
        self.cancel_after_first_chunk()
        def ignore(request, **_kwargs):
            self.assertEqual(request.get_header('Range'), 'bytes=7-')
            return Response(self.content, status=200)
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=ignore)
        self.assertEqual(target.read_bytes(), self.content)

    def test_invalid_range_never_appends_to_saved_prefix(self):
        self.cancel_after_first_chunk()
        for value in ['bytes 0-13/21', 'bytes 7-20/22', 'bytes 7-6/21', None]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    download_file(self.root, 'models/test.pth', self.spec,
                        open_url=lambda *_a, **_k: Response(b' model weights', status=206, headers={'Content-Range': value}))
                self.assertEqual(self.partial().read_bytes(), b'checked')
                self.assertFalse((self.root/'models/test.pth').exists())

    def test_range_rejection_retries_one_full_request(self):
        self.cancel_after_first_chunk()
        requests = []
        def open_url(request, **_kwargs):
            requests.append(request.get_header('Range'))
            if request.get_header('Range'):
                raise HTTPError(request.full_url, 416, 'Range not satisfiable', {}, None)
            return Response(self.content)
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=open_url)
        self.assertEqual(requests, ['bytes=7-', None])
        self.assertEqual(target.read_bytes(), self.content)

    def test_completed_partial_is_verified_and_published_without_network(self):
        self.cancel_after_first_chunk(size=21)
        target = download_file(self.root, 'models/test.pth', self.spec,
            open_url=lambda *_a, **_k: self.fail('The complete saved file needs no network'))
        self.assertEqual(target.read_bytes(), self.content)
        self.assertFalse(list(target.parent.glob('*.part')))

    def test_disk_check_requires_only_missing_bytes_and_preserves_prefix_on_full_restart(self):
        self.cancel_after_first_chunk()
        with patch('server.desktop_model_download.shutil.disk_usage', return_value=(21, 7, 14)):
            target = download_file(self.root, 'models/test.pth', self.spec,
                open_url=lambda *_a, **_k: Response(b' model weights', status=206, headers={'Content-Range': 'bytes 7-20/21'}))
        self.assertEqual(target.read_bytes(), self.content)
        target.unlink()
        self.cancel_after_first_chunk()
        with patch('server.desktop_model_download.shutil.disk_usage', return_value=(21, 7, 14)):
            with self.assertRaises(OSError):
                download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_a, **_k: Response(self.content))
        self.assertEqual(self.partial().read_bytes(), b'checked')

    def test_different_pinned_revision_does_not_reuse_an_old_partial(self):
        self.cancel_after_first_chunk()
        def full(request, **_kwargs):
            self.assertIsNone(request.get_header('Range'))
            return Response(self.content)
        target = download_file(self.root, 'models/test.pth', dict(self.spec, revision='b'*40), open_url=full)
        self.assertEqual(target.read_bytes(), self.content)

    def test_corrupted_resumed_file_is_discarded_and_repeat_downloads_fresh(self):
        self.cancel_after_first_chunk()
        self.partial().write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            download_file(self.root, 'models/test.pth', self.spec,
                open_url=lambda *_a, **_k: Response(b' model weights', status=206, headers={'Content-Range': 'bytes 7-20/21'}))
        self.assertFalse(list((self.root/'models').glob('*.part')))
        self.assertFalse((self.root/'models/test.pth').exists())
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_a, **_k: Response(self.content))
        self.assertEqual(target.read_bytes(), self.content)

    def test_partial_symlink_is_refused_without_touching_its_target(self):
        self.cancel_after_first_chunk()
        partial = self.partial()
        outside = self.root/'outside'; outside.write_bytes(b'original')
        partial.unlink(); partial.symlink_to(outside)
        with self.assertRaises((ValueError, OSError)):
            download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_a, **_k: self.fail('Unsafe partial must be refused before network'))
        self.assertEqual(outside.read_bytes(), b'original')

    def test_short_disk_writes_cannot_publish_a_truncated_file(self):
        fdopen = os.fdopen
        class ShortWrites:
            def __init__(self, file): self.file = file
            def __getattr__(self, name): return getattr(self.file, name)
            def __enter__(self): return self
            def __exit__(self, *args): return self.file.__exit__(*args)
            def write(self, value): return self.file.write(value[:3])
        with patch('server.desktop_model_download.os.fdopen', side_effect=lambda *a, **k: ShortWrites(fdopen(*a, **k))):
            target = download_file(self.root, 'models/test.pth', self.spec, open_url=lambda *_a, **_k: Response(self.content))
        self.assertEqual(target.read_bytes(), self.content)
