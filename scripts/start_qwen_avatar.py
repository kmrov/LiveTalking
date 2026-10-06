"""Start Qwen ASR, selected TTS and LiveTalking; stop owned processes on exit."""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen
import wave
from contextlib import contextmanager


ROOT = Path(__file__).resolve().parents[1]


def bundled_vllm(environment):
    path = ROOT.parent / environment / "bin/vllm"
    return str(path) if path.is_file() else "vllm"


def child_environment():
    env = os.environ.copy()
    cache = ROOT.parent / ".hf-cache-qwen"
    if cache.is_dir():
        env.setdefault("HF_HOME", str(cache))
        env.setdefault("HF_HUB_DISABLE_XET", "1")
    return env


def model_environment(env, name):
    model_env = env.copy()
    base = env.get("FLASHINFER_WORKSPACE_BASE") or env.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    model_env["FLASHINFER_WORKSPACE_BASE"] = str(Path(base).expanduser() / "livetalking-studio" / name.lower())
    return model_env


def parse_args(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    extra = []
    if "--" in argv:
        separator = argv.index("--")
        extra = argv[separator + 1:]
        argv = argv[:separator]
    parser = argparse.ArgumentParser(description="Start both Qwen speech models and LiveTalking")
    parser.add_argument("--ref-file", default=os.getenv("QWEN_REF_FILE", ""))
    parser.add_argument("--ref-text", default=os.getenv("QWEN_REF_TEXT", ""))
    parser.add_argument("--ref-text-file", default=os.getenv("QWEN_REF_TEXT_FILE", ""))
    parser.add_argument("--llm-prompt-file", default=os.getenv("QWEN_LLM_PROMPT_FILE", ""))
    parser.add_argument("--llm-reasoning-effort", default=os.getenv("QWEN_LLM_REASONING_EFFORT", ""),
                        choices=("", "none", "minimal", "low", "medium", "high", "xhigh"))
    parser.add_argument("--asr-vllm", default=os.getenv("QWEN_ASR_VLLM", bundled_vllm(".venv")))
    parser.add_argument("--tts-vllm", default=os.getenv("QWEN_TTS_VLLM", bundled_vllm(".venv-omni")))
    parser.add_argument("--tts-engine", choices=("qwen", "omnivoice"), default="qwen")
    parser.add_argument("--omni-python", default=str(ROOT.parent / ".venv-omnivoice/bin/python"))
    parser.add_argument("--tts-deploy-config", default=os.getenv("QWEN_TTS_DEPLOY_CONFIG", ""))
    parser.add_argument("--avatar-python", default=os.getenv("LIVETALKING_PYTHON", str(ROOT / ".venv/bin/python")))
    parser.add_argument("--asr-server", default=os.getenv("QWEN_ASR_SERVER", "http://127.0.0.1:8092"))
    parser.add_argument("--tts-server", default=os.getenv("QWEN_TTS_SERVER", "http://127.0.0.1:8091"))
    parser.add_argument("--asr-model", default="Qwen/Qwen3-ASR-0.6B")
    parser.add_argument("--asr-gpu-memory-utilization", type=float, default=0.18,
                        help="VRAM fraction reserved for ASR; default leaves room for TTS on one 24 GB GPU")
    parser.add_argument("--asr-max-model-len", type=int, default=4096)
    parser.add_argument("--tts-model", default="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    parser.add_argument("--timeout", type=int, default=900, help="seconds to wait for each model")
    parser.add_argument("--external-models", action="store_true", help="only wait for existing model servers")
    parser.add_argument("--dry-run", action="store_true", help="print commands without starting processes")
    parser.add_argument("--json-status", action="store_true", help="emit LT_STATUS JSON lifecycle lines")
    parser.add_argument("--model-registry-dir", default="", help="Studio-owned model process records")
    parser.add_argument("--keep-models-file", default="", help="Studio shutdown request to retain owned models")
    args = parser.parse_args(argv)
    args.app_args = extra
    if args.tts_engine == "omnivoice":
        args.tts_model = "k2-fsa/OmniVoice"
    return args


def emit_status(args, stage, state, detail=""):
    if args.json_status:
        print("LT_STATUS " + json.dumps({"stage": stage, "state": state, "detail": detail}, ensure_ascii=False), flush=True)


def executable(value):
    path = shutil.which(value)
    if not path:
        raise ValueError(f"Executable {value!r} not found; specify its path explicitly")
    # Keep the venv symlink: resolving bin/python to the base interpreter
    # would bypass the virtual environment entirely.
    return Path(path).absolute()


def reference(args):
    if not args.ref_file:
        raise ValueError("Specify --ref-file with a WAV sample of the avatar voice")
    path = Path(args.ref_file).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"Reference WAV not found: {path}")
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getnframes() == 0:
                raise ValueError("Reference WAV is empty")
    except wave.Error as error:
        raise ValueError(f"Reference must be an uncompressed WAV: {error}") from error
    if args.ref_text_file:
        transcript = Path(args.ref_text_file).expanduser().read_text(encoding="utf-8").strip()
    else:
        transcript = args.ref_text.strip()
    if not transcript:
        raise ValueError("Specify --ref-text or --ref-text-file with the exact WAV transcript")
    return path, transcript


def model_endpoint(server):
    parsed = urlsplit(server)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/"):
        raise ValueError(f"Invalid model server URL: {server}")
    return parsed


def model_status(server, expected):
    try:
        with urlopen(server.rstrip("/") + "/v1/models", timeout=2) as response:
            payload = json.load(response)
    except (OSError, ValueError, URLError):
        return "unavailable"
    models = [item.get("id") for item in payload.get("data", [])]
    if expected in models:
        return "ready"
    raise RuntimeError(f"Server {server} runs {models}, expected {expected}")


def tts_deploy_config(args, tts_vllm):
    if args.tts_deploy_config:
        path = Path(args.tts_deploy_config).expanduser().resolve()
    else:
        python = tts_vllm.parent / "python"
        if not python.exists():
            raise ValueError("Set --tts-deploy-config to vllm_omni/deploy/qwen3_tts.yaml")
        probe = subprocess.run(
            [str(python), "-c", "import pathlib, vllm_omni; print(pathlib.Path(vllm_omni.__file__).parent / 'deploy/qwen3_tts.yaml')"],
            text=True, capture_output=True, check=False,
        )
        if probe.returncode:
            raise ValueError("Cannot find vLLM-Omni deploy config; set --tts-deploy-config")
        lines = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
        if not lines:
            raise ValueError("Cannot find vLLM-Omni deploy config; set --tts-deploy-config")
        path = Path(lines[-1]).resolve()
    if not path.is_file():
        raise ValueError(f"Qwen3-TTS deploy config not found: {path}")
    return path


def server_command(vllm, model, server, tts_config=None, asr_args=None):
    endpoint = model_endpoint(server)
    if endpoint.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Use --external-models for a nonlocal model server")
    port = endpoint.port or (443 if endpoint.scheme == "https" else 80)
    command = [str(vllm), "serve", model, "--host", endpoint.hostname, "--port", str(port)]
    if tts_config:
        command += ["--omni", "--deploy-config", str(tts_config), "--trust-remote-code", "--enforce-eager"]
    if asr_args:
        command += ["--gpu-memory-utilization", str(asr_args.asr_gpu_memory_utilization),
                    "--max-model-len", str(asr_args.asr_max_model_len),
                    "--max-num-seqs", "4", "--enforce-eager"]
    return command


def avatar_command(args, python, ref_file, ref_text):
    command = [str(python), str(ROOT / "app.py"),
               "--ASR_BACKEND", "qwen3asr", "--ASR_SERVER", args.asr_server,
               "--ASR_MODEL", args.asr_model,
               "--tts", "qwen3tts", "--TTS_SERVER", args.tts_server,
               "--TTS_MODEL_ID", args.tts_model,
               "--REF_FILE", str(ref_file), "--REF_TEXT", ref_text]
    if args.llm_prompt_file:
        prompt = Path(args.llm_prompt_file).expanduser().resolve()
        if not prompt.is_file():
            raise ValueError(f"LLM prompt file not found: {prompt}")
        command += ["--llm_system_prompt_file", str(prompt)]
    if args.llm_reasoning_effort:
        command += ["--llm_reasoning_effort", args.llm_reasoning_effort]
    return command + args.app_args


class ModelStartupError(RuntimeError):
    def __init__(self, stage, detail):
        super().__init__(detail)
        self.stage = stage


def wait_for_models(args, pending):
    """Wait for the current model server and report its failing stage."""
    deadline = time.monotonic() + args.timeout
    while pending:
        for item in pending[:]:
            name, server, model, process, log_path = item
            stage = name.lower()
            if process is not None and process.poll() is not None:
                lines = log_path.read_text(errors="replace").splitlines()
                memory_failure = next((line for line in reversed(lines)
                                       if "No available memory for the cache blocks" in line
                                       or "CUDA out of memory" in line), "")
                tail = "\n".join(lines[-20:])
                detail = f"{model} exited with code {process.returncode}. Log: {log_path}"
                if memory_failure:
                    detail += f"\nGPU memory error: {memory_failure.strip()}"
                raise ModelStartupError(stage, f"{detail}\n{tail}")
            try:
                status = model_status(server, model)
            except RuntimeError as error:
                raise ModelStartupError(stage, str(error)) from error
            if status == "ready":
                print(f"{name} ready: {server}", flush=True)
                emit_status(args, stage, "ready", server)
                pending.remove(item)
        if pending:
            if time.monotonic() >= deadline:
                name, server, model, _, log_path = pending[0]
                raise ModelStartupError(name.lower(), f"Timed out waiting for {model} at {server}; see {log_path}")
            time.sleep(2)


@contextmanager
def uninterrupted_cleanup():
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def stop_processes(processes):
    with uninterrupted_cleanup():
        _stop_processes(processes)


def record_owned_model(directory, stage, process):
    if not directory:
        return
    registry = Path(directory)
    registry.mkdir(mode=0o700, parents=True, exist_ok=True)
    stat = Path(f"/proc/{process.pid}/stat").read_text(encoding="utf-8")
    start_time = stat[stat.rfind(")") + 2:].split()[19]
    destination = registry / f"{process.pid}.json"
    temporary = registry / f".{process.pid}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps({"stage": stage, "pid": process.pid, "startTime": start_time}), encoding="utf-8")
    temporary.replace(destination)


def cleanup_owned_processes(models, avatar, keep_file=None, registry_dir=""):
    marker = Path(keep_file) if keep_file else None
    keep_models = bool(marker and marker.is_file())
    if marker:
        marker.unlink(missing_ok=True)
    if avatar:
        stop_processes([avatar])
    if not keep_models:
        stop_processes(models)
        if registry_dir:
            for process in models:
                (Path(registry_dir) / f"{process.pid}.json").unlink(missing_ok=True)
    return keep_models


def _stop_processes(processes):
    for process in reversed(processes):
        try:
            # The API leader may have exited while its vLLM engine is still in
            # the process group. We own the entire new session, not just Popen.
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for process in reversed(processes):
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            continue
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            continue
        time.sleep(1)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def wait_for_services(args, app, owned_models):
    while True:
        for name, process in owned_models:
            code = process.poll()
            if code is not None:
                detail = f"{name} exited with code {code}"
                emit_status(args, name, "failed", detail)
                raise RuntimeError(detail)
        try:
            return app.wait(timeout=1)
        except subprocess.TimeoutExpired:
            continue


def main(argv=None):
    args = parse_args(argv)
    if not 0 < args.asr_gpu_memory_utilization < 1:
        raise ValueError("--asr-gpu-memory-utilization must be between 0 and 1")
    ref_file, ref_text = reference(args)
    avatar_python = executable(args.avatar_python)
    avatar = avatar_command(args, avatar_python, ref_file, ref_text)
    model_endpoint(args.asr_server)
    model_endpoint(args.tts_server)
    commands = []
    for name, server, model, vllm_name in (
        ("ASR", args.asr_server, args.asr_model, args.asr_vllm),
        ("TTS", args.tts_server, args.tts_model, args.tts_vllm),
    ):
        status = "unavailable" if args.dry_run else model_status(server, model)
        if status == "ready":
            print(f"{name}: using existing server at {server}", flush=True)
            if not args.dry_run:
                emit_status(args, name.lower(), "ready", f"existing server at {server}")
            continue
        if args.external_models:
            if args.dry_run:
                continue
            commands.append((name, server, model, None))
            continue
        if name == "TTS" and args.tts_engine == "omnivoice":
            endpoint = model_endpoint(server)
            if endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "localhost", "::1"):
                raise ValueError("Local OmniVoice server requires a loopback HTTP URL")
            command = [str(executable(args.omni_python)), str(ROOT / "scripts/omnivoice_server.py"),
                       "--host", endpoint.hostname, "--port", str(endpoint.port or 80),
                       "--ref-file", str(ref_file), "--ref-text", ref_text]
        else:
            vllm = executable(vllm_name)
            tts_config = tts_deploy_config(args, vllm) if name == "TTS" else None
            command = server_command(vllm, model, server, tts_config, args if name == "ASR" else None)
        commands.append((name, server, model, command))

    if args.dry_run:
        for name, _, _, command in commands:
            print(f"{name}: {shlex.join(command)}")
        print("Avatar:", shlex.join(avatar))
        return 0

    log_dir = Path(tempfile.mkdtemp(prefix="livetalking-qwen-"))
    env = child_environment()
    print(f"Model logs: {log_dir}", flush=True)
    model_processes = []
    app = None
    owned_stages = []
    owned_models = []
    stage = "asr"
    try:
        for name, server, model, command in commands:
            stage = name.lower()
            emit_status(args, stage, "starting", server)
            process = None
            log_path = log_dir / f"{name.lower()}.log"
            if command:
                print(f"Starting {name}: {model}", flush=True)
                log = log_path.open("w")
                try:
                    process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                               start_new_session=True, env=model_environment(env, name))
                finally:
                    log.close()
                model_processes.append(process)
                record_owned_model(args.model_registry_dir, stage, process)
                owned_stages.append(stage)
                owned_models.append((stage, process))
            else:
                print(f"Waiting for external {name}: {server}", flush=True)
            wait_for_models(args, [(name, server, model, process, log_path)])
        stage = "livetalking"
        emit_status(args, stage, "starting", "launching avatar server")
        print("Starting LiveTalking. Press Ctrl+C to stop.", flush=True)
        app = subprocess.Popen(avatar, cwd=ROOT, start_new_session=True, env=env)
        owned_stages.append(stage)
        return wait_for_services(args, app, owned_models)
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, RuntimeError, TimeoutError) as error:
        emit_status(args, getattr(error, "stage", stage), "failed", str(error))
        raise
    finally:
        kept = cleanup_owned_processes(model_processes, app, args.keep_models_file, args.model_registry_dir)
        for stopped_stage in reversed(owned_stages):
            if kept and stopped_stage != 'livetalking':
                continue
            emit_status(args, stopped_stage, "stopped", "owned process stopped")


if __name__ == "__main__":
    def handle_termination(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handle_termination)
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, TimeoutError) as error:
        print(f"Start failed: {error}", file=sys.stderr)
        sys.exit(1)
