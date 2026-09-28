"""Real loopback HTTP and worker-restart coverage, without models or GPU."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen

from server.desktop_model_download import download_file


class DesktopModelResumeHttpTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.content = b'01234567' * (512 * 1024)  # Four MiB; each emitted chunk is durable.
        self.spec = dict(repo='Qwen/test', revision='a'*40, file='model.safetensors', size=len(self.content), algorithm='sha256', digest=hashlib.sha256(self.content).hexdigest())
        self.requests = []
        self.mode = 'normal'
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                requested = self.headers.get('Range')
                owner.requests.append(requested)
                offset = int(requested.removeprefix('bytes=').removesuffix('-')) if requested else 0
                self.send_response(206 if requested else 200)
                self.send_header('Content-Length', str(len(owner.content)-offset))
                if requested:
                    self.send_header('Content-Range', f'bytes {offset}-{len(owner.content)-1}/{len(owner.content)}')
                self.end_headers()
                body = owner.content[offset:]
                if owner.mode == 'truncate': body = body[:1024*1024]
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(self.close_server)
        self.url = f'http://127.0.0.1:{self.server.server_port}/model'

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()

    def open_url(self, request, **kwargs):
        return urlopen(Request(self.url, headers=dict(request.header_items())), **kwargs)

    def test_real_truncated_http_response_continues_from_saved_bytes(self):
        self.mode = 'truncate'
        with self.assertRaises(ValueError):
            download_file(self.root, 'models/test.pth', self.spec, open_url=self.open_url)
        self.assertFalse((self.root/'models/test.pth').exists())
        self.mode = 'normal'
        target = download_file(self.root, 'models/test.pth', self.spec, open_url=self.open_url)
        self.assertEqual(self.requests, [None, 'bytes=1048576-'])
        self.assertEqual(target.read_bytes(), self.content)

    def test_new_worker_resumes_after_forced_exit_and_reports_saved_progress(self):
        request_file = self.root/'request.json'
        request_file.write_text(json.dumps(dict(spec=self.spec, root=str(self.root), url=self.url)))
        script = """
import json,os,signal,sys
from urllib.request import Request,urlopen
from server.desktop_model_download import download_file
request=json.load(open(sys.argv[1]));stop=sys.argv[2]=='kill'
def transport(value,**kwargs):
    return urlopen(Request(request['url'],headers=dict(value.header_items())),**kwargs)
def progress(value):
    print(json.dumps(value),flush=True)
    if stop and value['downloadedBytes']:
        os.kill(os.getpid(),signal.SIGKILL)
download_file(request['root'],'models/test.pth',request['spec'],open_url=transport,emit=progress)
"""
        killed = subprocess.run([sys.executable, '-c', script, str(request_file), 'kill'], capture_output=True, text=True, timeout=10)
        self.assertEqual(killed.returncode, -9, killed.stderr)
        self.assertFalse((self.root/'models/test.pth').exists())
        continued = subprocess.run([sys.executable, '-c', script, str(request_file), 'resume'], capture_output=True, text=True, timeout=10)
        self.assertEqual(continued.returncode, 0, continued.stderr)
        events = [json.loads(line) for line in continued.stdout.splitlines()]
        self.assertEqual(events[0]['downloadedBytes'], 1048576)
        self.assertEqual(self.requests, [None, 'bytes=1048576-'])
        self.assertEqual((self.root/'models/test.pth').read_bytes(), self.content)
        self.assertFalse(list((self.root/'models').glob('*.part')))
