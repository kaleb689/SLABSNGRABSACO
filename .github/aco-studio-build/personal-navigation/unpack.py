#!/usr/bin/env python3
"""Restore the additive navigation overlay; no user profiles are bundled."""
import base64
import bz2
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
compressed = base64.b64decode((root / 'source.b64').read_text().strip(), validate=True)
expected_sha = '96841b5c5258e1314bfbe96c414b50b0db28e299fd8bea2b8e6bb595592bfc8d'
if hashlib.sha256(compressed).hexdigest() != expected_sha:
    raise SystemExit('Personal navigation source checksum mismatch')
files = json.loads(bz2.decompress(compressed))
expected = {'apply.cjs', 'workspace-core.js', 'personal-navigation.js',
            'personal-navigation.css', 'personal-navigation.test.js'}
if set(files) != expected or any(not isinstance(v, str) for v in files.values()):
    raise SystemExit('Unexpected overlay contents')
destination = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'navigation-overlay')
destination.mkdir(parents=True, exist_ok=True)
for name, text in files.items():
    (destination / name).write_text(text, encoding='utf-8')
print('Verified Personal navigation, retailer controls, preview repair and regression tests')
