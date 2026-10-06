"""Small loopback speech server for Studio's OmniVoice voice-cloning option.

PyPI OmniVoice 0.2.1 generates one text chunk at a time. For streaming requests
we split on punctuation and send each finished chunk before synthesizing the
next. A single chunk still needs to finish before its first audio byte.
"""

import argparse
import base64
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
import os
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf


MODEL_ID = 'k2-fsa/OmniVoice'
MAX_REQUEST = 15 * 1024 * 1024
WARMUP_TEXT = 'Проверяем, как звучит речь после прогрева модели.'


def speech_chunks(text, max_chars=55):
    """Prefer sentence boundaries; use commas only for a long sentence."""
    def split_at(value, punctuation):
        parts, current = [], []
        for index, char in enumerate(value):
            current.append(char)
            if char in punctuation and not (
                char == '.' and 0 < index < len(value) - 1
                and value[index - 1].isdigit() and value[index + 1].isdigit()
            ):
                parts.append(''.join(current).strip())
                current.clear()
        if current:
            parts.append(''.join(current).strip())
        return [part for part in parts if part]

    parts = []
    for sentence in split_at(text, '.!?…。！？'):
        parts.extend(split_at(sentence, ',;:，；：、') if len(sentence) > max_chars else [sentence])
    chunks = []
    for part in parts:
        if chunks and (len(chunks[-1]) < 18 or len(chunks[-1]) + 1 + len(part) <= max_chars):
            chunks[-1] += ' ' + part
        else:
            chunks.append(part)
    return chunks


def create_server(host, port, model, num_step=16, warm_reference=None):
    if not 4 <= num_step <= 64:
        raise ValueError('OmniVoice num_step must be between 4 and 64')
    inference_lock = threading.Lock()
    cached = {'key': None, 'prompt': None}

    def voice_prompt(raw, transcript):
        key = sha256(raw + b'\0' + transcript.encode('utf-8')).digest()
        if cached['key'] != key:
            waveform, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=False)
            if waveform.ndim == 2:
                waveform = waveform.mean(axis=1)
            cached['prompt'] = model.create_voice_clone_prompt(
                ref_audio=(waveform, rate), ref_text=transcript)
            cached['key'] = key
        return cached['prompt']

    if warm_reference is not None:
        raw, transcript = warm_reference
        prompt = voice_prompt(raw, transcript.strip())
        started = time.perf_counter()
        model.generate(text=WARMUP_TEXT, language='Russian', voice_clone_prompt=prompt,
                       num_step=num_step, pad_duration=0.02, fade_duration=0.02)
        logging.info('OmniVoice voice and GPU warmup finished in %.3f s', time.perf_counter() - started)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            logging.info('%s %s', self.address_string(), format % args)

        def send_json(self, status, payload):
            body = json.dumps(payload).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/v1/models':
                self.send_json(200, {'object': 'list', 'data': [{'id': MODEL_ID, 'object': 'model'}]})
            else:
                self.send_json(404, {'error': 'Not found'})

        def do_POST(self):
            if self.path != '/v1/audio/speech':
                self.send_json(404, {'error': 'Not found'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_REQUEST:
                    raise ValueError('Speech request is empty or too large')
                body = json.loads(self.rfile.read(length))
                text, transcript, audio = body.get('input'), body.get('ref_text'), body.get('ref_audio')
                if not isinstance(text, str) or not text.strip() or len(text) > 10000:
                    raise ValueError('input must be nonempty text of at most 10000 characters')
                if not isinstance(transcript, str) or not transcript.strip():
                    raise ValueError('ref_text must be the sample transcript')
                if not isinstance(audio, str) or not audio.startswith('data:audio/wav;base64,'):
                    raise ValueError('ref_audio must be a base64 WAV data URL')
                if body.get('response_format') != 'pcm':
                    raise ValueError('response_format must be pcm')
                raw = base64.b64decode(audio.partition(',')[2], validate=True)
                if len(raw) > 10 * 1024 * 1024:
                    raise ValueError('Reference WAV is too large')
            except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
                self.send_json(400, {'error': str(error)})
                return

            headers_sent = False
            try:
                with inference_lock:
                    prompt = voice_prompt(raw, transcript.strip())
                    if model.sampling_rate != 24000:
                        raise RuntimeError(f'Expected 24000 Hz OmniVoice output, got {model.sampling_rate}')
                    chunks = speech_chunks(text.strip()) if body.get('stream') is True else [text.strip()]
                    streamed = len(chunks) > 1
                    for part in chunks:
                        options = {'pad_duration': 0.02, 'fade_duration': 0.02} if streamed else {}
                        generated = model.generate(text=part, language='Russian',
                                                   voice_clone_prompt=prompt, num_step=num_step,
                                                   **options)[0]
                        pcm = np.rint(np.clip(np.asarray(generated, dtype=np.float32), -1, 1) * 32767).astype('<i2').tobytes()
                        if not headers_sent:
                            self.send_response(200)
                            self.send_header('Content-Type', 'audio/pcm')
                            if streamed:
                                self.send_header('Transfer-Encoding', 'chunked')
                            else:
                                self.send_header('Content-Length', str(len(pcm)))
                            self.end_headers()
                            headers_sent = True
                        if streamed:
                            self.wfile.write(f'{len(pcm):X}\r\n'.encode('ascii') + pcm + b'\r\n')
                        else:
                            self.wfile.write(pcm)
                        self.wfile.flush()
                    if streamed:
                        self.wfile.write(b'0\r\n\r\n')
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                logging.exception('OmniVoice synthesis failed')
                if headers_sent:
                    self.close_connection = True
                else:
                    self.send_json(500, {'error': 'OmniVoice synthesis failed; see the TTS log'})

    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8091)
    parser.add_argument('--num-step', type=int, default=os.environ.get('OMNIVOICE_NUM_STEP', '16'))
    parser.add_argument('--ref-file', type=Path)
    parser.add_argument('--ref-text', default='')
    args = parser.parse_args()
    if args.host not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('OmniVoice server must bind to loopback')
    if not 4 <= args.num_step <= 64:
        parser.error('--num-step must be between 4 and 64')
    if bool(args.ref_file) != bool(args.ref_text.strip()):
        parser.error('--ref-file and --ref-text must be provided together for warmup')
    warm_reference = None
    if args.ref_file:
        raw = args.ref_file.read_bytes()
        if len(raw) > 10 * 1024 * 1024:
            parser.error('--ref-file is too large for OmniVoice warmup')
        warm_reference = (raw, args.ref_text)
    logging.basicConfig(level=logging.INFO)
    import torch
    from omnivoice import OmniVoice
    if not torch.cuda.is_available():
        raise RuntimeError('OmniVoice needs a working CUDA driver for Studio local mode')
    model = OmniVoice.from_pretrained(MODEL_ID, device_map='cuda:0', dtype=torch.float16)
    server = create_server(args.host, args.port, model, args.num_step, warm_reference)
    logging.info('OmniVoice ready at http://%s:%s', args.host, server.server_port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
