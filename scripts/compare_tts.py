"""Measure an already running Qwen or OmniVoice TTS server with one voice sample.

Run the two models separately with the same arguments. Pass all GPU PIDs owned by
the selected TTS service to exclude ASR, the avatar and desktop compositor.
"""

import argparse
import base64
import json
from pathlib import Path
import subprocess
import threading
import time
import wave

import requests


def gpu_mib(pids):
    result = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
                            capture_output=True, text=True, timeout=5, check=True)
    values = {}
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(',')]
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            values[int(parts[0])] = int(parts[1])
    return sum(values.get(pid, 0) for pid in pids) if pids else sum(values.values())


def measure(url, reference, transcript, text, pids):
    body = {'input': text, 'language': 'Russian', 'task_type': 'Base',
            'ref_audio': 'data:audio/wav;base64,' + base64.b64encode(reference).decode('ascii'),
            'ref_text': transcript, 'stream': True, 'stream_format': 'audio', 'response_format': 'pcm'}
    stop = threading.Event()
    samples = []

    def poll():
        while not stop.is_set():
            try:
                samples.append(gpu_mib(pids))
            except (OSError, subprocess.SubprocessError):
                pass
            stop.wait(0.1)

    watcher = threading.Thread(target=poll, daemon=True)
    watcher.start()
    start = time.perf_counter()
    first = None
    chunks = []
    try:
        with requests.post(url.rstrip('/') + '/v1/audio/speech', json=body, stream=True, timeout=(5, 180)) as response:
            response.raise_for_status()
            for chunk in response.iter_content(chunk_size=4096):
                if chunk:
                    if first is None:
                        first = time.perf_counter() - start
                    chunks.append(chunk)
    finally:
        stop.set()
        watcher.join(timeout=6)
    elapsed = time.perf_counter() - start
    pcm = b''.join(chunks)
    if not pcm or len(pcm) % 2:
        raise RuntimeError('TTS returned empty or incomplete 16-bit PCM')
    duration = len(pcm) / (24000 * 2)
    return {'first_audio_s': round(first, 3), 'total_s': round(elapsed, 3),
            'audio_s': round(duration, 3), 'rtf': round(elapsed / duration, 3),
            'gpu_peak_mib': max(samples) if samples else None}, pcm


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--model', required=True, choices=['Qwen/Qwen3-TTS-12Hz-1.7B-Base', 'k2-fsa/OmniVoice'])
    parser.add_argument('--ref-file', type=Path, required=True)
    parser.add_argument('--ref-text-file', type=Path, required=True)
    parser.add_argument('--text', default='Привет! Я рад снова тебя видеть. Расскажи, как прошёл твой день?')
    parser.add_argument('--pid', action='append', type=int, default=[], help='TTS GPU process PID; repeat for every vLLM engine process')
    parser.add_argument('--runs', type=int, default=2)
    parser.add_argument('--output', type=Path, required=True, help='Output prefix for JSON and final WAV')
    args = parser.parse_args()
    if args.runs < 1 or args.runs > 10:
        parser.error('--runs must be between 1 and 10')
    models = requests.get(args.url.rstrip('/') + '/v1/models', timeout=5).json()['data']
    if args.model not in [item['id'] for item in models]:
        parser.error(f'{args.url} does not serve {args.model}')
    reference = args.ref_file.read_bytes()
    transcript = args.ref_text_file.read_text(encoding='utf-8').strip()
    results = []
    for number in range(args.runs):
        metric, pcm = measure(args.url, reference, transcript, args.text, args.pid)
        results.append(metric)
        print(json.dumps({'run': number + 1, **metric}, ensure_ascii=False), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output.with_suffix('.wav')), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(pcm)
    args.output.with_suffix('.json').write_text(json.dumps({
        'model': args.model, 'reference': str(args.ref_file), 'text': args.text,
        'gpu_pids': args.pid, 'memory_scope': 'selected PIDs' if args.pid else 'all GPU processes',
        'runs': results,
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
