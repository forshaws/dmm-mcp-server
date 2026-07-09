#!/usr/bin/env python3
"""
storage_target.py — deterministic byte-offset fetch service.

Plays the role of a storage target for the DMM local_blob resolver demo.
Not a real storage protocol (no NVMe-oF, no iSCSI) — a small, deliberately
plain TCP request/response service, understood only by resolver.js's
handleLocalBlob on the other end. Its only job: given a filename, offset
and length, open the file, seek to the offset, read exactly that many
bytes, and return them. This is what makes "resolution" and "fetch" two
genuinely separate, independently timed hops rather than one function call.

Wire format (newline-delimited JSON, one request per connection):
  request:  {"filename": "lindisfarne_blob_001.bin", "offset": 18446744, "length": 2048}
  response: {"status": "OK", "content_base64": "..."}
         or {"status": "ERROR", "message": "..."}

Run:
  python3 storage_target.py --base-path /home/tqnn/data/lindisfarne_blobs --port 9600
"""

import argparse
import base64
import json
import os
import socketserver
import sys


class StorageTargetHandler(socketserver.StreamRequestHandler):
    def handle(self):
        base_path = self.server.base_path

        raw = self.rfile.readline()
        if not raw:
            return

        try:
            req = json.loads(raw.decode('utf8'))
            filename = req['filename']
            offset = int(req['offset'])
            length = int(req['length'])
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            self._respond({'status': 'ERROR', 'message': f'bad request: {e}'})
            return

        # ping-style request (length 0): just confirm the file exists
        if length == 0:
            filepath = os.path.join(base_path, filename)
            if os.path.isfile(filepath):
                self._respond({'status': 'OK'})
            else:
                self._respond({'status': 'ERROR', 'message': 'file not found'})
            return

        filepath = os.path.realpath(os.path.join(base_path, filename))
        if not filepath.startswith(os.path.realpath(base_path) + os.sep):
            # refuse path traversal outside base_path
            self._respond({'status': 'ERROR', 'message': 'invalid filename'})
            return

        if not os.path.isfile(filepath):
            self._respond({'status': 'ERROR', 'message': 'file not found'})
            return

        try:
            with open(filepath, 'rb') as f:
                f.seek(offset)
                data = f.read(length)
        except OSError as e:
            self._respond({'status': 'ERROR', 'message': str(e)})
            return

        if len(data) != length:
            self._respond({
                'status': 'ERROR',
                'message': f'short read: requested {length} bytes, got {len(data)} (offset past end of file?)'
            })
            return

        self._respond({
            'status': 'OK',
            'content_base64': base64.b64encode(data).decode('ascii')
        })

    def _respond(self, payload):
        self.wfile.write(json.dumps(payload).encode('utf8'))


class StorageTargetServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self, server_address, handler_cls, base_path):
        self.base_path = base_path
        super().__init__(server_address, handler_cls)


def main():
    parser = argparse.ArgumentParser(description='Deterministic byte-offset fetch service for DMM local_blob demo.')
    parser.add_argument('--base-path', required=True, help='Directory containing the blob files')
    parser.add_argument('--host', default='127.0.0.1', help='Bind host (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=9600, help='Bind port (default: 9600)')
    args = parser.parse_args()

    base_path = os.path.realpath(args.base_path)
    if not os.path.isdir(base_path):
        print(f'error: base path does not exist: {base_path}', file=sys.stderr)
        sys.exit(1)

    server = StorageTargetServer((args.host, args.port), StorageTargetHandler, base_path)
    print(f'storage_target listening on {args.host}:{args.port}, base_path={base_path}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nshutting down')
        server.shutdown()


if __name__ == '__main__':
    main()
