#!/usr/bin/python3
"""Unprivileged SSH entry. Identity is supplied by kernel SO_PEERCRED, not JSON."""
import base64
import json
import os
import select
import socket
import stat
import struct
import sys
import time

SOCKET = '/run/xian-oa-team-release.sock'
MAX_REQUEST = 16384
MAX_RESPONSE = 65536
TIMEOUT = 620

def main():
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 32768:
            raise ValueError()
        data = base64.b64decode(sys.argv[1], validate=True)
        if not data or len(data) > MAX_REQUEST:
            raise ValueError()
        # Broker performs strict JSON/schema parsing. Never import writable code.
        metadata = os.lstat(SOCKET)
        if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) not in (0o660, 0o666):
            raise ValueError()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            connection.connect(SOCKET)
            _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            if uid != 0:
                raise ValueError()
            connection.sendall(data)
            connection.shutdown(socket.SHUT_WR)
            output = bytearray()
            deadline = time.monotonic() + TIMEOUT
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([connection], [], [], remaining)[0]:
                    raise TimeoutError()
                chunk = connection.recv(8192)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) >= MAX_RESPONSE:
                    raise ValueError()
        result = json.loads(output)
        if type(result) is not dict:
            raise ValueError()
        print(json.dumps(result, separators=(',', ':')))
        return 1 if 'error' in result else 0
    except Exception:
        print('{"error":"Team release entry failed; query status before retrying start"}')
        return 1

if __name__ == '__main__':
    sys.exit(main())
