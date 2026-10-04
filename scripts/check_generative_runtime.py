"""Small CPU-only prerequisite check called by Studio."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.generative_runtime import inspect_runtime

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    result = inspect_runtime(args.root, args.model)
    print(json.dumps(result), flush=True)
    sys.exit(0 if result['ok'] else 1)
