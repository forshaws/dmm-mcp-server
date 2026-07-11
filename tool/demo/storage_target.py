#!/usr/bin/env python3
"""
storage_target.py — DMM Level 2 raw block fetcher (SN655-equivalent testbed)

Listens on a loopback-only TCP socket, accepts a JSON coordinate payload
{"lba": N, "sectors": M}, and returns the raw bytes read directly from
the block device node at that sector range.

Hardening applied vs. the original sketch:
  - Bound to 127.0.0.1 only — a raw block-read primitive has no business
    being reachable off-box, even in testbed form.
  - LBA/sectors validated as positive integers and bounds-checked against
    actual device size before any seek happens.
  - Optional O_DIRECT read path so latency telemetry measures the device,
    not the Linux page cache.
"""

import socketserver
import json
import base64
import os
import sys

SECTOR_SIZE = 4096
DEVICE_PATH = os.environ.get("DMM_L2_DEVICE", "/dev/loop0")
BIND_HOST = "127.0.0.1"   # loopback only — do not change without an ACL layer in front
BIND_PORT = 9600
USE_O_DIRECT = os.environ.get("DMM_L2_O_DIRECT", "0") == "1"


def get_device_size(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        return os.lseek(fd, 0, os.SEEK_END)
    finally:
        os.close(fd)


class StorageTargetHandler(socketserver.StreamRequestHandler):
    def handle(self):
        raw = self.rfile.readline()
        if not raw:
            return

        try:
            req = json.loads(raw.decode("utf8"))

            # --- validation: this is a raw device, there is no filesystem
            #     to stop a bad offset from seeking into someone else's data ---
            if "lba" not in req or "sectors" not in req:
                self._respond({"status": "ERROR", "message": "lba and sectors are required"})
                return

            lba = int(req["lba"])
            sectors = int(req["sectors"])

            if lba < 0 or sectors < 1:
                self._respond({"status": "ERROR", "message": "lba must be >= 0 and sectors >= 1"})
                return

            device_size = get_device_size(DEVICE_PATH)
            end_offset = (lba + sectors) * SECTOR_SIZE
            if end_offset > device_size:
                self._respond({
                    "status": "ERROR",
                    "message": f"requested range exceeds device size "
                               f"({end_offset} > {device_size})",
                })
                return

            data = self._read_sectors(lba, sectors)

            self._respond({
                "status": "OK",
                "lba": lba,
                "sectors": sectors,
                "content_base64": base64.b64encode(data).decode("ascii"),
            })

        except (ValueError, TypeError) as e:
            self._respond({"status": "ERROR", "message": f"malformed request: {e}"})
        except Exception as e:
            self._respond({"status": "ERROR", "message": str(e)})

    def _read_sectors(self, lba, sectors):
        length = sectors * SECTOR_SIZE
        offset = lba * SECTOR_SIZE

        if USE_O_DIRECT and hasattr(os, "O_DIRECT"):
            # O_DIRECT requires the read buffer to be sector-aligned; since we
            # always read in whole SECTOR_SIZE multiples this holds naturally.
            fd = os.open(DEVICE_PATH, os.O_RDONLY | os.O_DIRECT)
            try:
                os.lseek(fd, offset, os.SEEK_SET)
                return os.read(fd, length)
            finally:
                os.close(fd)
        else:
            with open(DEVICE_PATH, "rb") as f:
                f.seek(offset)
                return f.read(length)

    def _respond(self, payload):
        self.wfile.write(json.dumps(payload).encode("utf8"))
        self.wfile.write(b"\n")


def main():
    print(f"[storage_target] device={DEVICE_PATH} o_direct={USE_O_DIRECT} "
          f"bind={BIND_HOST}:{BIND_PORT}")
    try:
        size = get_device_size(DEVICE_PATH)
        print(f"[storage_target] device size: {size / (1024**3):.2f} GiB "
              f"({size // SECTOR_SIZE} sectors)")
    except OSError as e:
        print(f"[storage_target] WARNING: could not open {DEVICE_PATH}: {e}", file=sys.stderr)
        print("[storage_target] is the loop device set up? sudo losetup --block-size 4096 "
              "/dev/loop0 <target>", file=sys.stderr)

    with socketserver.ThreadingTCPServer((BIND_HOST, BIND_PORT), StorageTargetHandler) as server:
        server.allow_reuse_address = True
        server.serve_forever()


if __name__ == "__main__":
    main()
