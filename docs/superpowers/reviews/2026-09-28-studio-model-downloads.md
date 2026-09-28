# Studio: automatic model downloads — verification

User approved adding automatic weight downloads to the existing Create and Start flows, including local Qwen ASR/TTS. Python, CUDA and software package installation are outside this change. Local integration was previously authorized.

## Result

- Create installs only the chosen avatar preparation models: S3FD for Wav2Lip, S3FD/VAE/MuseTalk v15/face parsing for MuseTalk.
- Start installs the chosen avatar runtime models and both Qwen models in local speech mode. External speech does not install Qwen.
- The fixed Hugging Face catalogue contains pinned revisions, exact sizes and SHA256 or Git blob SHA1. Downloads use a temporary file, integrity verification and atomic no-replace publication. Existing nonempty model files are retained.
- Progress is visible during avatar preparation and startup. Cancel/Stop signals only the owned process. Ordinary cancellation or download failure removes the current partial file; repeat retains completed files. A hard kill can leave an ignored `.part` file; partial bytes are not resumed.
- Qwen snapshots become active only after every required file is installed. Ready BIN or sharded snapshots are reused without replacing their active revision. Startup uses Hugging Face offline mode.

## Evidence

- `npm test`: 26 test files passed. Named run `node --test --test-isolation=none test/*.test.mjs`: 106 tests passed.
- `.venv/bin/python -m unittest discover -s tests -p 'test_desktop*.py'`: 35 tests passed.
- `npm run build`: passed.
- `npm run smoke`: passed, including startup download progress, Stop cancellation, failure/repeat/start and existing avatar library/Batya flows. Progress viewport bounds are checked without scrolling settings.
- Real download of the pinned VAE config: 547 bytes; Git blob SHA1 `0db26717579be63eb0ddbf15b43faa43700dfe5a` matched. Repeating made no network request.
- Real downloads of five pinned HuBERT metadata/tokenizer files passed checksum verification. `Wav2Vec2Processor.from_pretrained(..., local_files_only=True)` initialized with 32 vocabulary entries.
- Startup planning against the original installed MuseTalk/Wav2Lip and Qwen caches required no downloads. The real Python startup CLI emitted `completed`.
- Independent read-only review approved integration. Both Important findings were fixed with failing-before-fix regression tests: missing HuBERT vocabulary and unnecessary redownload of ready BIN/sharded Qwen snapshots. The reviewer also verified offline loading of Qwen ASR/TTS text tokenizers and the TTS speech feature extractor using catalogue metadata files.

## Verification limits

Network verification downloaded real small files, not every multigigabyte checkpoint. Full fresh model installation followed by GPU inference was not run. Model integrity checks, cancellation, disk limits, atomic publication and snapshot activation were exercised with real filesystem operations and controlled network responses. Existing installed checkpoints and cache references were preserved.
