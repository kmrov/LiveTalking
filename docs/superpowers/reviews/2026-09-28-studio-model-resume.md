# Studio: resumable model downloads — verification

User requested resumption of interrupted model files in the existing avatar Create/Repeat and profile Start flows. This is a bounded extension of the downloader introduced in `d2eb7a5`.

## Behavior

- A persistent `.studio-model-<id>.part` is stored beside its model. Its identity includes the destination name, pinned repository/revision/file, expected size, algorithm and checksum. Unrelated versions are never combined.
- Cancel, network failure and process termination preserve received chunks. A repeat hashes the saved prefix and requests the remaining bytes; its first progress event includes the saved byte count.
- HTTP 206 ranges are validated before append. HTTP 200 restarts the file; HTTP 416 makes one full request. Content length and encoding are checked when present. These branches follow the [HTTP range semantics in RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-14).
- Resumption checks disk space for remaining bytes. A full restart conservatively requires space for the complete file before discarding a valid prefix.
- Only a complete file with the catalogue checksum is atomically published. Known damaged bytes/checksum failures are discarded; malformed range responses preserve the existing prefix. Symlink, nonregular or hardlinked partial files are refused.
- Partial files from the previous downloader's random temporary filenames are ignored because their source identity is unknown.

## Evidence

- Full desktop Python suite: 49 tests passed, including cancellation, connection loss, prefix/revision identity, checksum corruption, HTTP fallback/invalid ranges, disk limits, short writes and snapshot activation.
- Real loopback HTTP test: a truncated 4 MiB response retained 1 MiB; retry requested `bytes=1048576-` and published the verified full file.
- Real separate worker test: SIGKILL after the first durable MiB; a new worker reported the retained byte count, requested only the remainder and published the exact expected file.
- Real Hugging Face S3FD test at pinned revision `405eda8eab9f65c1a6e0c292a5dee5a08089e2ae`: canceled after 1,048,576 bytes; repeat received HTTP 206 and `Content-Range: bytes 1048576-89843224/89843225`. Final 89,843,225 bytes matched SHA256 `619a31681264d3f7f7fc7a16a42cbbe8b23f31a256f75a366e5a1bcd59b33543`. Only a temporary test copy was downloaded and automatically removed; installed checkpoints were preserved.
- `npm test`: 26 test files passed. `npm run build`: passed. Existing renderer and IPC already handle nonzero resumed progress.
- Independent read-only review approved integration without findings. The reviewer ran 23 targeted tests and supplementary cases for invalid response length/encoding, hardlink/FIFO refusal and Git blob SHA1 resumption.

## Limits

The real external transfer test used S3FD, not every multigigabyte Qwen checkpoint. Resumption applies to future files created with the persistent identity; previously discarded bytes cannot be recovered. Prefix integrity is established by the final whole-file checksum.
