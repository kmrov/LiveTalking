#!/usr/bin/env python3
"""Studio startup model installation; structured progress on stdout."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.desktop_model_download import ensure_models


def event(state, **values):
    print('LT_MODELS ' + json.dumps({'version': 1, 'state': state, **values}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True)
    args = parser.parse_args()
    try:
        source = Path(args.profile)
        if source.stat().st_size > 65536:
            raise ValueError('Download request is too large.')
        request = json.loads(source.read_text())
        if set(request) != {'root', 'model', 'speechMode'} or not all(isinstance(value, str) for value in request.values()):
            raise ValueError('Invalid download request.')
        ensure_models(request, lambda value: event('downloading', **value), scope='start')
        event('completed')
        return 0
    except Exception as error:
        event('failed', message=str(error))
        return 1


if __name__ == '__main__':
    sys.exit(main())
