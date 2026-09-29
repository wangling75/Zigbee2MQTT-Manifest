#!/usr/bin/env python3
"""Validate the published v12 bundle's structural and semantic invariants.

The C++ differential test proves that the matcher selects the same definition
as the official resolver. These checks add the binary-layout, exposes-table,
and release metadata guarantees that the ESP32 loader depends on.
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = Path(os.environ.get("Z2M_BUNDLE", ROOT / "dist" / "z2m_bundle.candidate.bin"))
MANIFEST = Path(os.environ.get("Z2M_MANIFEST", ROOT / "dist" / "z2m_manifest.candidate.json"))
IR = Path(os.environ.get("Z2M_IR", ROOT / "build_ir_candidate" / "z2m_bundle.ndjson"))
HEADER_SIZE = 128
INDEX_ENTRY_SIZE = 32
RECORD_HEADER_SIZE = 20
RECORD_V8_SIZE = 8
RECORD_V9_SIZE = 20
RECORD_V10_SIZE = 32
RECORD_V11_SIZE = 28
RECORD_V12_SIZE = 16
EXPOSE_SIZE = 40
EXPOSE_META_MASK = 0x07
TYPE_NAMES = {
    0: "binary",
    1: "numeric",
    2: "enum",
    3: "composite",
    4: "text",
    5: "list",
    6: "lock",
    7: "switch",
    8: "cover",
    9: "climate",
    10: "light",
    11: "fan",
    12: "other",
}


def u16(raw: bytes, offset: int) -> int:
    return struct.unpack_from("<H", raw, offset)[0]


def u32(raw: bytes, offset: int) -> int:
    return struct.unpack_from("<I", raw, offset)[0]


def official_exposes() -> list[dict]:
    rows: list[dict] = []
    if not IR.exists():
        return rows
    for line in IR.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        for expose in record.get("exposes", []) or []:
            if isinstance(expose, dict) and str(expose.get("property", "") or ""):
                rows.append(expose)
    return rows


def main() -> int:
    raw = BUNDLE.read_bytes()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if raw[:4] != b"Z2MB":
        raise SystemExit("bundle magic is not Z2MB")
    if (u16(raw, 4), u16(raw, 6)) != (12, 12):
        raise SystemExit("bundle is not v12/v12")

    model_offset = u32(raw, 12)
    model_count = u32(raw, 16)
    fp_offset = u32(raw, 20)
    fp_count = u32(raw, 24)
    records_offset = u32(raw, 28)
    strings_offset = u32(raw, 32)
    constraints_offset = u32(raw, 76)
    constraints_count = u32(raw, 80)
    endpoint_offset = u32(raw, 84)
    endpoint_count = u32(raw, 88)
    cluster_offset = u32(raw, 92)
    cluster_count = u32(raw, 96)
    white_label_offset = u32(raw, 100)
    white_label_count = u32(raw, 104)
    vm_code_offset = u32(raw, 108)
    vm_code_size = u32(raw, 112)
    vm_version = u16(raw, 116)
    capabilities = u32(raw, 118)
    record_data_size = u32(raw, 84 + 36)
    vm_program_count = u32(raw, 84 + 40)

    assert model_offset == HEADER_SIZE
    assert model_offset + model_count * INDEX_ENTRY_SIZE == fp_offset
    assert fp_offset + fp_count * INDEX_ENTRY_SIZE == endpoint_offset
    assert endpoint_offset + endpoint_count * 16 == cluster_offset
    assert cluster_offset + cluster_count * 2 == white_label_offset
    assert white_label_offset + white_label_count * 64 == constraints_offset
    assert constraints_offset + constraints_count * 56 == records_offset
    assert records_offset + record_data_size == vm_code_offset
    assert vm_code_offset + vm_code_size == strings_offset
    assert strings_offset <= len(raw) == u32(raw, 36)
    assert constraints_count >= fp_count
    assert vm_version == 1
    assert record_data_size > 0
    assert vm_program_count <= 65535
    assert vm_code_size % 12 == 0
    assert capabilities & 0x1FFF == 0x1FFF
    assert manifest["sha256"] == hashlib.sha256(raw).hexdigest()
    assert manifest["bytes"] == len(raw)
    assert manifest["device_count"] == u32(raw, 8)
    assert manifest["model_index_count"] == model_count
    assert manifest["fingerprint_index_count"] == fp_count
    assert manifest["fingerprint_constraint_count"] == constraints_count

    def get_string(offset: int) -> str:
        if not offset:
            return ""
        if strings_offset + offset + 2 > len(raw):
            raise AssertionError(f"string offset {offset} is out of bounds")
        length = u16(raw, strings_offset + offset)
        start = strings_offset + offset + 2
        if start + length > len(raw):
            raise AssertionError(f"string length at offset {offset} is out of bounds")
        return raw[start:start + length].decode("utf-8", "replace")

    bundle_type_counts: dict[str, int] = {}
    bundle_units = 0
    bundle_options = 0
    bundle_polarity = 0
    bundle_names = 0
    bundle_steps = 0
    bundle_config = 0
    bundle_diagnostic = 0
    bundle_disabled = 0
    total_exposes = 0
    seen_records: set[int] = set()

    for index in range(model_count):
        entry_offset = model_offset + index * INDEX_ENTRY_SIZE
        record_offset = u32(raw, entry_offset + 8)
        record_len = u32(raw, entry_offset + 12)
        assert record_len >= RECORD_HEADER_SIZE + RECORD_V8_SIZE + RECORD_V9_SIZE + RECORD_V10_SIZE + RECORD_V11_SIZE + RECORD_V12_SIZE
        record_abs = records_offset + record_offset
        assert record_abs + record_len <= records_offset + record_data_size

        declared_offset = u32(raw, record_abs + 20)
        declared_count = u32(raw, record_abs + 24)
        assert u16(raw, record_abs + 44) == 1
        assert declared_count <= 256
        assert declared_offset + declared_count * 4 <= record_data_size

        if record_offset in seen_records:
            continue
        seen_records.add(record_offset)

        v11 = struct.unpack_from("<IIIIIII", raw, record_abs + 80)
        for offset, count, width in (
            (v11[0], v11[1], 32),
            (v11[2], v11[3], 12),
            (v11[4], v11[5], 8),
        ):
            assert count <= 256
            if count == 0:
                assert offset == 0
            else:
                assert offset > 0
                assert offset + count * width <= record_data_size
        assert v11[6] == 0

        exposes_offset, exposes_count, reserved0, reserved1 = struct.unpack_from(
            "<IIII", raw, record_abs + 108
        )
        assert exposes_count <= 512
        if exposes_count == 0:
            assert exposes_offset == 0
            assert reserved0 == 0 and reserved1 == 0
            continue
        assert exposes_offset > 0
        assert exposes_offset + exposes_count * EXPOSE_SIZE <= record_data_size
        assert reserved0 > 0 and reserved1 == exposes_count
        assert reserved0 == exposes_offset + exposes_count * EXPOSE_SIZE
        assert reserved0 + exposes_count * 4 <= record_data_size
        for expose_index in range(exposes_count):
            expose_abs = record_abs + exposes_offset + expose_index * EXPOSE_SIZE
            (
                property_offset,
                unit_offset,
                values_offset,
                value_on_offset,
                value_off_offset,
                endpoint_offset,
                _min_value,
                _max_value,
                expose_type,
                _access,
                _flags,
                reserved,
                name_offset,
            ) = struct.unpack_from("<IIIIIIffBBBBI", raw, expose_abs)
            step_value = struct.unpack_from(
                "<f", raw, record_abs + reserved0 + expose_index * 4
            )[0]
            # The reserved byte carries v12 expose metadata. Unknown bits
            # must be rejected so a future format cannot silently change
            # the meaning of data this loader ignores.
            assert reserved & ~EXPOSE_META_MASK == 0
            assert property_offset > 0
            assert name_offset > 0
            assert get_string(property_offset)
            assert get_string(name_offset)
            type_name = TYPE_NAMES.get(expose_type)
            assert type_name is not None
            bundle_type_counts[type_name] = bundle_type_counts.get(type_name, 0) + 1
            total_exposes += 1
            if reserved & 0x01:
                bundle_config += 1
            if reserved & 0x02:
                bundle_diagnostic += 1
            if reserved & 0x04:
                bundle_disabled += 1
            if unit_offset:
                bundle_units += 1
            if values_offset:
                bundle_options += 1
            if value_on_offset or value_off_offset:
                bundle_polarity += 1
            if name_offset:
                bundle_names += 1
            if step_value != 0.0:
                bundle_steps += 1

    official = official_exposes()
    if official:
        official_counts: dict[str, int] = {}
        official_units = 0
        official_options = 0
        official_polarity = 0
        official_steps = 0
        official_config = 0
        official_diagnostic = 0
        official_disabled = 0
        for expose in official:
            type_name = str(expose.get("type", "") or "")
            official_counts[type_name] = official_counts.get(type_name, 0) + 1
            step = expose.get("value_step")
            if isinstance(step, (int, float)) and float(step) != 0.0:
                official_steps += 1
            if expose.get("unit"):
                official_units += 1
            values = expose.get("values")
            if isinstance(values, list) and any(str(value) != "" for value in values):
                official_options += 1
            if expose.get("value_on") is not None or expose.get("value_off") is not None:
                official_polarity += 1
            category = str(expose.get("category", "") or "").lower()
            if category == "config":
                official_config += 1
            elif category == "diagnostic":
                official_diagnostic += 1
            if expose.get("enabled_by_default") is False:
                official_disabled += 1
        assert total_exposes == len(official), (total_exposes, len(official))
        assert bundle_type_counts == official_counts, (bundle_type_counts, official_counts)
        assert bundle_units == official_units, (bundle_units, official_units)
        assert bundle_options == official_options, (bundle_options, official_options)
        assert bundle_polarity == official_polarity, (bundle_polarity, official_polarity)
        assert bundle_names == len(official)
        assert bundle_steps == official_steps, (bundle_steps, official_steps)
        assert bundle_config == official_config, (bundle_config, official_config)
        assert bundle_diagnostic == official_diagnostic, (bundle_diagnostic, official_diagnostic)
        assert bundle_disabled == official_disabled, (bundle_disabled, official_disabled)

    print(
        "PASS: Z2MB v12 layout, complete exposes table, and manifest metadata "
        f"(devices={u32(raw, 8)} models={model_count} fingerprints={fp_count} "
        f"exposes={total_exposes} names={bundle_names} units={bundle_units} "
        f"options={bundle_options} polarity={bundle_polarity} "
        f"steps={bundle_steps} "
        f"config={bundle_config} diagnostic={bundle_diagnostic} "
        f"disabled={bundle_disabled})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
