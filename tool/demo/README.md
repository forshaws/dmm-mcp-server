# tools/demo — raw LBA block storage resolution demo (SN655 Level 2)

Proof-of-concept: DMM resolves a filereference to a raw hardware
`{lba, sectors}` coordinate, then fetches those exact 4KiB-aligned sectors
from a separate process over a socket, reading directly off a raw block
device — no filesystem, no VFS, no byte-offset-into-a-file abstraction.
This is the true Level 2 evolution of the original `local_blob` demo,
emulating how an enterprise NVMe drive (e.g. Western Digital Ultrastar DC
SN655) actually addresses storage: by Logical Block Address, in whole
4KiB sectors.

**The old `local_blob` / `off`/`len` scheme is retired.** It's kept in
`tqnn_resolvers.json` for reference but is not the recommended path for
new work — everything below replaces it.

## Files

- `storage_target.py` — standalone fetch service. Given `{lba, sectors}`,
  seeks directly on the raw block device node and reads whole sectors.
  Bound to `127.0.0.1` only — never exposed off-box. Run this before
  anything else.
- `tqnn_ingest_lba.py` — production ingester. Packs source `.jsonl`
  records into a local sector-aligned staging image, then indexes each
  record into DMM via `storeDoc` with an `sn655_pool_` filereference.
  Same credentials/PQR/threading/resume machinery as `tqnn_ingest.py`.
- `resolver.js` changes — adds a `local_lba` handler that talks to
  `storage_target.py` over the same TCP-socket pattern as `local_blob`,
  but with `lba`/`sectors` instead of `filename`/`off`/`len`.
- `tqnn_resolvers.json` changes — adds the `sn655_pool_` scheme pointing
  at `local_lba`.

## Filereference format

```
<pool_name>::lba<N>::sectors<N>::
```

Example: `sn655_pool_001::lba1380::sectors1::`

Note: DMM appends a unix timestamp on write and strips back to the last
`::` on read. For records without an `fpd_` suffix, this means the
filereference returned by `searchDoc`/`multiSearchDoc` often comes back
**without** a trailing `::` — e.g. `sn655_pool_001::lba1380::sectors1`.
This is expected, not a bug. Both `resolver.js`'s `local_lba` handler and
`local_blob` handler parse by splitting the string on `::` and matching
each token by position, so a missing trailing `::` never affects parsing.
Anything writing a *new* filereference should still always end it in `::`
— that's what lets DMM's timestamp-strip-on-read recover the original
string cleanly in the first place.

## Setting up the block device (loop device or real USB drive)

The demo needs a raw block device presenting 4KiB sectors. A USB flash
drive mapped through a loop device works identically to real enterprise
NVMe as far as this code is concerned — only the addressing model matters,
not the physical media.

```bash
lsblk                              # confirm which node is the target drive
sudo wipefs -a /dev/sdX            # replace sdX with the confirmed node
sudo losetup -b 4096 /dev/loop0 /dev/sdX
losetup -l -O NAME,BACK-FILE,LOG-SEC   # confirm 4096-byte sectors
```

## Running it

1. **Ingest and stage.** Run `tqnn_ingest_lba.py` against your source
   `.jsonl` file(s). This builds a local staging image (default
   `./sn655_pool_001.raw`) with every record packed into whole 4KiB
   sectors, and indexes each into DMM:
   ```
   python3 tqnn_ingest_lba.py records_0001.jsonl \
     --image-path ./sn655_pool_001.raw \
     --pool-name sn655_pool_001 \
     --dataset lba \
     --creds tqnn_setup_credentials.txt \
     --base-url https://tqnn.local \
     --device-capacity-gib 59.8 \
     --resume --fpd --threads 8
   ```
   Re-running against more source files auto-continues LBAs from wherever
   the staging image currently ends.

2. **Copy the staging image onto the appliance.** Ingestion only writes
   locally — nothing is on the physical drive until you `dd` it across:
   ```bash
   scp sn655_pool_001.raw tqnn@tqnn.local:~/
   ssh tqnn@tqnn.local
   sudo dd if=~/sn655_pool_001.raw of=/dev/loop0 bs=4096
   ```

3. **Start the fetch service** on the appliance, pointed at the loop
   device:
   ```bash
   DMM_L2_DEVICE=/dev/loop0 python3 storage_target.py
   ```
   If it needs to run as a non-root user, add that user to the `disk`
   group first (`sudo usermod -aG disk <user>`, then re-login or
   `newgrp disk`) rather than running the service as root.

4. **Confirm `tqnn_resolvers.json`** has the `sn655_pool_` entry with
   `target_host`/`target_port`/`sector_size` matching step 3, and that it's
   actually been deployed — `resolver.js` caches the config at process
   startup, so any edit needs a restart (`pm2 restart <process>`) to take
   effect. This config file changes fairly often in a live repo; if it's
   git-tracked, commit deliberate edits rather than relying on them
   surviving a `git pull` by luck.

5. **Call `tqnn_get`** with an `sn655_pool_...::lbaN::sectorsN::`
   filereference as normal — it routes to `handleLocalLba`, hits
   `storage_target.py`, and returns `status`, `lba`, `sectors`, `fetch_ms`,
   and base64-encoded bytes.

## Verifying end to end

Skip the resolver and hit `storage_target.py` directly first, to isolate
whether a problem is in the fetch service or in the resolver/MCP layer:

```python
import socket, json, base64
s = socket.create_connection(('127.0.0.1', 9600))
s.sendall((json.dumps({'lba': 0, 'sectors': 1}) + '\n').encode())
data = json.loads(s.recv(65536).decode())
print(base64.b64decode(data['content_base64']).rstrip(b'\x00').decode())
```

## Known gaps / notes

- `fetch_ms` in the resolver response times the socket round trip only,
  not the upstream semantic resolution step in DMM.
- `storage_target.py` must be started manually or added to your process
  manager — `resolver.js` does not spawn it.
- O_DIRECT reads are available (`DMM_L2_O_DIRECT=1`) for latency
  measurements that need to bypass the Linux page cache — off by default
  since it adds a variable you don't want for a first correctness check.
- The old `lindisfarne_blob_` / `local_blob` entry remains in
  `tqnn_resolvers.json` for reference but has no fetch service running
  behind it (port 9600 is now owned by the LBA service). Treat it as dead
  configuration, not a live fallback.
