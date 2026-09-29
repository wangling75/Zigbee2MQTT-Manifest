#!/usr/bin/env python3
"""Guard the generated model index against invented normalized aliases.

The official resolver first looks up the exact lower-cased model key and only
falls back to the NUL/whitespace-normalized key when that exact key exists in
the official MODELS_INDEX. The generated index must not contain a normalized
key that the official index cannot resolve.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def normalized(value: str) -> str:
    return value.replace("\x00", " ").strip().lower()


def main() -> int:
    generated_path = Path(
        sys.argv[1] if len(sys.argv) > 1 else ROOT / "build_ir_candidate" / "z2m_index.json"
    )
    generated = json.loads(generated_path.read_text(encoding="utf-8"))

    import subprocess

    script = """
import fs from 'node:fs';
const index = JSON.parse(fs.readFileSync('node_modules/zigbee-herdsman-converters/dist/models-index.json', 'utf8'));
console.log(JSON.stringify(Object.keys(index)));
"""
    raw = subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )
    official = set(json.loads(raw))

    invalid = sorted(set(generated) - set(official))

    if invalid:
        for key in invalid[:20]:
            print(f"FAIL: generated key {key!r} is not present in official models-index")
        print(f"FAIL: {len(invalid)} invented normalized model aliases")
        return 1

    print(f"PASS: model index has no invented normalized aliases (keys={len(generated)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
