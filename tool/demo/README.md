# tools/demo — physical-address resolution demo

Proof-of-concept: DMM resolves a filereference to a `{file, offset, length}`
coordinate, then fetches those exact bytes from a separate process over a
socket — not a real storage protocol (no NVMe-oF, no iSCSI), just enough
separation to time resolution and fetch as two independent hops.

## Files

- `storage_target.py` — standalone fetch service. Given a filename, offset,
  and length, opens the file, seeks, reads, returns the bytes. Run this
  before anything else.
- `resolver.js` changes — adds a `local_blob` handler that talks to
  `storage_target.py` instead of reading files in-process.
- `tqnn_resolvers.json` changes — adds the `lindisfarne_blob_` scheme
  pointing at `local_blob`.

## Filereference format

```
<blobfile>::off<N>::len<N>::
```

Example: `lindisfarne_blob_001.bin::off18446744::len2048::`

## Running it

1. Put your blob file(s) in a directory, e.g. `/home/tqnn/data/lindisfarne_blobs/`.

2. Start the fetch service:
   ```
   python3 storage_target.py --base-path /home/tqnn/data/lindisfarne_blobs --port 9600
   ```

3. Confirm `tqnn_resolvers.json` has the `lindisfarne_blob_` entry with
   `target_host`/`target_port` matching step 2.

4. Call `tqnn_get` with a `lindisfarne_blob_...::offN::lenN::` filereference
   as normal — it'll route to `handleLocalBlob`, hit `storage_target.py`,
   and return `status`, `fetch_ms`, and base64-encoded bytes.

## Known gaps (not yet built)

- No blob-writing / offset-capture step yet — blobs and their offsets need
  to be produced by an ingest pass (not included here).
- `storage_target.py` must be started manually or added to your process
  manager — `resolver.js` does not spawn it.
- `fetch_ms` in the resolver response times the socket round trip only,
  not the upstream semantic resolution step.
