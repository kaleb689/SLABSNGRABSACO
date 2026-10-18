#!/usr/bin/env python3
"""Restore the checked source overlay. This is source packaging, not app data."""
import base64
import bz2
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
parts = sorted(root.glob('source.part-*.b64'))
if [p.name for p in parts] != [f'source.part-{i:02}.b64' for i in range(3)]:
    raise SystemExit('Workshop source archive is incomplete')
compressed = base64.b64decode(''.join(p.read_text() for p in parts), validate=True)
if hashlib.sha256(compressed).hexdigest() != 'b1812c4205d0bf57af37d83d7ff646c5f13c044d7b56015fe484cc0238494cfe':
    raise SystemExit('Workshop compressed-source checksum mismatch')
raw = bz2.decompress(compressed)
if hashlib.sha256(raw).hexdigest() != 'bca532aaf2d9a20d85db89b7888b3a35840d98162a294b2e43dd9548ba81f4ea':
    raise SystemExit('Workshop source checksum mismatch')
files = json.loads(raw)
expected = {'apply.cjs', 'jig-field-core.js', 'profile-draft-core.js',
            'profile-workshop-service.js', 'profile-workshop-ui.js',
            'profile-workshop.css', 'profile-workshop.test.js',
            'workshop-address-methods.js.txt', 'workshop-app-methods.js.txt',
            'workshop-card-methods.js.txt', 'workshop-profile-methods.js.txt'}
if set(files) != expected or any(not isinstance(v, str) for v in files.values()):
    raise SystemExit('Workshop archive contains unexpected files')
destination = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'workshop-overlay')
destination.mkdir(parents=True, exist_ok=True)
for name, text in files.items():
    (destination / name).write_text(text, encoding='utf-8')
print(f'Verified and restored {len(files)} workshop source files to {destination}')
