#!/usr/bin/env python3
"""
Z2M Binary Bundle Compiler v3.0 for ESP32 Gateway
Compiles Zigbee2MQTT device definitions into a compact, zero-RAM binary bundle
with dual sorted index tables (Model Hash + Fingerprint Hash) for O(log N) Flash binary search.
"""

import os
import sys
import json
import struct
import hashlib
from typing import List, Dict, Any

MAGIC = b"Z2MB"
FORMAT_VERSION = 3
IR_VERSION = 3
HEADER_SIZE = 128
INDEX_ENTRY_SIZE = 32

# Datatype enum
DATATYPE_MAP = {
    "bool": 0,
    "uint8": 1,
    "int16": 2,
    "uint16": 3,
    "int32": 4,
    "uint32": 5,
    "enum8": 6,
    "raw": 7,
    "string": 8,
    "single_prec": 9,
    "double_prec": 10,
    "uint48": 11,
    "int24": 12,
    "bitmap16": 13,
    "value": 14
}

# Opcode enum
OP_READ_ATTR = 0x01
OP_WRITE_ATTR = 0x02
OP_COMMAND = 0x03
OP_REPORT_ATTR = 0x04
OP_BIND_CLUSTER = 0x05
OP_TUYA_DP = 0x06
OP_TRANSFORM = 0x07
OP_MAP_ENUM = 0x08
OP_BITFIELD = 0x09
OP_DYNAMIC_ENDPOINT = 0x0A

def fnv1a_32(text: str) -> int:
    """Standard FNV-1a 32-bit hash for fast case-insensitive matching."""
    if not text:
        return 0
    h = 0x811C9DC5
    for b in text.lower().strip().encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def category_to_enum(cat: str) -> int:
    mapping = {
        "generic_device": 0,
        "on_off_light": 1,
        "dimmable_light": 2,
        "color_light": 3,
        "on_off_plugin_unit": 4,
        "on_off_switch": 5,
        "temp_sensor": 6,
        "humidity_sensor": 7,
        "contact_sensor": 8,
        "occupancy_sensor": 9,
        "light_sensor": 10,
        "water_leak_sensor": 11,
        "smoke_sensor": 12,
        "thermostat": 13,
        "window_covering": 14,
        "door_lock": 15
    }
    return mapping.get(cat.lower(), 0)

def to_int(val, default=0) -> int:
    if val is None:
        return default
    if isinstance(val, int):
        return val
    if isinstance(val, str):
        val = val.strip()
        if not val:
            return default
        try:
            return int(val, 0)
        except Exception:
            try:
                return int(float(val))
            except Exception:
                return default
    try:
        return int(val)
    except Exception:
        return default

def to_float(val, default=1.0) -> float:
    if val is None:
        return default
    try:
        return float(val)
    except Exception:
        return default

class BinaryBundleBuilderV3:
    def __init__(self):
        self.records = []
        self.model_index_entries = []
        self.fp_index_entries = []
        self.string_table = bytearray(b'\x00') # 0 is empty string
        self.string_map = {"": 0}
        self.seen_model_hashes = set()
        self.seen_fp_hashes = set()

    def add_string(self, s: str) -> int:
        if not s:
            return 0
        if s in self.string_map:
            return self.string_map[s]
        offset = len(self.string_table)
        s_bytes = s.encode('utf-8') + b'\x00'
        self.string_table.extend(s_bytes)
        self.string_map[s] = offset
        return offset

    def add_record(self, dev: Dict[str, Any]):
        self.records.append(dev)

    def build(self, out_bin_path: str) -> Dict[str, Any]:
        data_buffer = bytearray()
        record_map = [] # (rec_offset, rec_len)

        for dev in self.records:
            rec_start = len(data_buffer)

            model = dev.get("model", "")
            vendor = dev.get("vendor", "")
            desc = dev.get("description", "")
            category = dev.get("category", "")
            cat_enum = category_to_enum(category)
            flags = dev.get("flags", 0)

            model_off = self.add_string(model)
            vendor_off = self.add_string(vendor)
            desc_off = self.add_string(desc)

            endpoints = dev.get("endpoints", {})
            fz_rules = dev.get("fromZigbee", [])
            tz_rules = dev.get("toZigbee", [])
            tuya_dps = dev.get("tuyaDatapoints", [])
            cfg = dev.get("configure", {})
            binds = cfg.get("binds", [])
            reporting = cfg.get("reporting", [])

            # 1. Record Header (20 bytes aligned)
            rec_hdr = struct.pack(
                "<IIIBBBBBBBB",
                model_off,
                vendor_off,
                desc_off,
                cat_enum,
                flags & 0xFF,
                min(len(fz_rules), 255),
                min(len(tz_rules), 255),
                min(len(tuya_dps), 255),
                min(len(endpoints), 255),
                min(len(binds), 255),
                min(len(reporting), 255)
            )
            data_buffer.extend(rec_hdr)

            # 2. Endpoints (4 bytes each aligned: ep_id uint8, pad8 uint8, name_off uint16)
            for ep_name, ep_id in endpoints.items():
                name_off = min(self.add_string(str(ep_name)), 65535)
                data_buffer.extend(struct.pack("<BBH", to_int(ep_id, 1), 0, name_off))

            # 3. fromZigbee IR Rules (20 bytes each: op:1, dtype:1, cl:2, at:2, ep:1, pad:1, tgt_off:4, scale:4, offset:4)
            for fz in fz_rules:
                op = OP_READ_ATTR
                if fz.get("op") == "REPORT_ATTRIBUTE": op = OP_REPORT_ATTR
                elif fz.get("op") == "TRANSFORM": op = OP_TRANSFORM
                elif fz.get("op") == "MAP_ENUM": op = OP_MAP_ENUM

                dtype = DATATYPE_MAP.get(fz.get("datatype", "uint16"), 1)
                cl = to_int(fz.get("cluster", 0))
                at = to_int(fz.get("attr", 0))
                ep = to_int(fz.get("endpoint", 0))
                tgt_off = self.add_string(str(fz.get("target", "")))
                scale = to_float(fz.get("scale", 1.0))
                offset = to_float(fz.get("offset", 0.0))

                rule_bytes = struct.pack("<BBHHBBIff", op, dtype, cl, at, ep, 0, tgt_off, scale, offset)
                data_buffer.extend(rule_bytes)

            # 4. toZigbee IR Rules (16 bytes each: op:1, ep:1, cl:2, cmd:2, cmd_on:1, cmd_off:1, tgt_off:4, scale:4)
            for tz in tz_rules:
                op = OP_COMMAND if tz.get("op") == "COMMAND" else OP_WRITE_ATTR
                ep = to_int(tz.get("endpoint", 0))
                cl = to_int(tz.get("cluster", 0))
                cmd = to_int(tz.get("cmd") or tz.get("attr", 0))
                cmd_on = to_int(tz.get("cmd_on", 1))
                cmd_off = to_int(tz.get("cmd_off", 0))
                tgt_off = self.add_string(str(tz.get("target", "")))
                scale = to_float(tz.get("scale", 1.0))

                tz_bytes = struct.pack("<BBHHBBI f", op, ep, cl, cmd, cmd_on, cmd_off, tgt_off, scale)
                data_buffer.extend(tz_bytes)

            # 5. Tuya DP Rules (20 bytes each: dp:1, dtype:1, pad:2, tgt_off:4, scale:4, offset:4, map_off:4)
            for dp in tuya_dps:
                dp_id = to_int(dp.get("dp", 0))
                dtype_str = dp.get("datatype", "value")
                dtype = 0 # value
                if dtype_str == "enum": dtype = 1
                elif dtype_str == "bool": dtype = 2
                elif dtype_str == "raw": dtype = 3
                elif dtype_str == "string": dtype = 4

                tgt_off = self.add_string(str(dp.get("target", "")))
                scale = to_float(dp.get("scale", 1.0))
                offset = to_float(dp.get("offset", 0.0))

                map_obj = dp.get("map")
                map_str = json.dumps(map_obj) if map_obj else ""
                map_off = self.add_string(map_str) if map_str else 0

                dp_bytes = struct.pack("<BBHIffI", dp_id, dtype, 0, tgt_off, scale, offset, map_off)
                data_buffer.extend(dp_bytes)

            # 6. Reporting config (8 bytes each: cluster, attr, min, max)
            for rep in reporting:
                cl = to_int(rep.get("cluster", 0))
                at = to_int(rep.get("attr", 0))
                min_i = to_int(rep.get("min", 10))
                max_i = to_int(rep.get("max", 3600))
                data_buffer.extend(struct.pack("<HHHH", cl, at, min_i, max_i))

            # 7. Binds (2 bytes each: cluster)
            for b in binds:
                data_buffer.extend(struct.pack("<H", to_int(b, 0)))

            rec_len = len(data_buffer) - rec_start
            rec_idx = len(record_map)
            record_map.append((rec_start, rec_len))

            # Generate Index Entries for all models and fingerprints
            models = dev.get("models", [model])
            for m in models:
                if not m: continue
                m_hash = fnv1a_32(m)
                if m_hash in self.seen_model_hashes:
                    continue
                self.seen_model_hashes.add(m_hash)
                v_hash = fnv1a_32(vendor)

                # Fixed 32 bytes entry
                entry = struct.pack(
                    "<IIIIHHBBBBQ",
                    m_hash,
                    v_hash,
                    rec_start,
                    rec_len,
                    cat_enum,
                    flags & 0xFFFF,
                    min(len(fz_rules), 255),
                    min(len(tz_rules), 255),
                    min(len(tuya_dps), 255),
                    min(len(endpoints), 255),
                    0 # reserved
                )
                self.model_index_entries.append((m_hash, entry))

            # Fingerprints
            fps = dev.get("fingerprints", [])
            for fp in fps:
                fp_mfg = fp.get("manufacturerName", "")
                fp_model = fp.get("modelID", "")
                fp_key = f"{fp_mfg}|{fp_model}"
                fp_hash = fnv1a_32(fp_key)
                if fp_hash in self.seen_fp_hashes:
                    continue
                self.seen_fp_hashes.add(fp_hash)
                v_hash = fnv1a_32(fp_mfg)
                m_code = to_int(fp.get("manufacturerCode", 0))

                fp_entry = struct.pack(
                    "<IIIIHHBBBBQ",
                    fp_hash,
                    v_hash,
                    rec_start,
                    rec_len,
                    cat_enum,
                    flags & 0xFFFF,
                    min(len(fz_rules), 255),
                    min(len(tz_rules), 255),
                    min(len(tuya_dps), 255),
                    min(len(endpoints), 255),
                    m_code
                )
                self.fp_index_entries.append((fp_hash, fp_entry))

        # Sort indexes strictly by hash ascending for binary search
        self.model_index_entries.sort(key=lambda x: x[0])
        self.fp_index_entries.sort(key=lambda x: x[0])

        model_idx_bytes = b"".join(e[1] for e in self.model_index_entries)
        fp_idx_bytes = b"".join(e[1] for e in self.fp_index_entries)

        # Offsets
        model_idx_off = HEADER_SIZE
        fp_idx_off = model_idx_off + len(model_idx_bytes)
        records_off = fp_idx_off + len(fp_idx_bytes)
        strings_off = records_off + len(data_buffer)
        total_size = strings_off + len(self.string_table)

        payload = model_idx_bytes + fp_idx_bytes + data_buffer + self.string_table
        sha256_raw = hashlib.sha256(payload).digest()
        crc_val = 0 # Optional CRC

        # Header v3 (128 bytes)
        header = struct.pack(
            "<4sHHIIIIIIIII32s",
            MAGIC,
            FORMAT_VERSION,
            IR_VERSION,
            len(self.records),
            model_idx_off,
            len(self.model_index_entries),
            fp_idx_off,
            len(self.fp_index_entries),
            records_off,
            strings_off,
            total_size,
            crc_val,
            sha256_raw
        ).ljust(HEADER_SIZE, b'\x00')

        full_binary = header + payload

        with open(out_bin_path, "wb") as f:
            f.write(full_binary)

        sha256_hex = hashlib.sha256(full_binary).hexdigest()
        print(f"[Binary Compiler v3] Successfully compiled Binary Bundle: {out_bin_path}")
        print(f"  - Device Records: {len(self.records)}")
        print(f"  - Model Index Entries: {len(self.model_index_entries)} ({len(model_idx_bytes)} bytes)")
        print(f"  - Fingerprint Index Entries: {len(self.fp_index_entries)} ({len(fp_idx_bytes)} bytes)")
        print(f"  - Record Data Buffer: {len(data_buffer)} bytes")
        print(f"  - String Table: {len(self.string_table)} bytes")
        print(f"  - Total Binary Size: {len(full_binary)} bytes ({len(full_binary)/1024/1024:.2f} MB)")
        print(f"  - SHA256: {sha256_hex}")

        return {
            "format": "z2m-binary-bundle-v3",
            "version": "3.0.0",
            "ir_version": IR_VERSION,
            "bundle": os.path.basename(out_bin_path),
            "bytes": len(full_binary),
            "sha256": sha256_hex,
            "device_count": len(self.records),
            "model_index_count": len(self.model_index_entries),
            "fingerprint_index_count": len(self.fp_index_entries),
            "index_entry_size": INDEX_ENTRY_SIZE
        }

def compile_bundle(input_dir: str, out_bin: str, out_manifest: str):
    builder = BinaryBundleBuilderV3()
    bundle_ndjson = os.path.join(input_dir, "z2m_bundle.ndjson")
    if not os.path.exists(bundle_ndjson):
        bundle_ndjson = os.path.join(input_dir, "z2m_bundle.json")

    assert os.path.exists(bundle_ndjson), f"Bundle NDJSON file not found at {bundle_ndjson}!"

    print(f"[Binary Compiler v3] Reading IR records from {bundle_ndjson}...")
    with open(bundle_ndjson, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                builder.add_record(rec)
            except Exception as e:
                pass

    os.makedirs(os.path.dirname(out_bin) or ".", exist_ok=True)
    meta = builder.build(out_bin)

    manifest_data = {
        "format": "z2m-binary-bundle-v3",
        "bundle_version": "3.0.0",
        "ir_version": IR_VERSION,
        "min_firmware": "v3.0.0",
        "bundle": os.path.basename(out_bin),
        "bytes": meta["bytes"],
        "sha256": meta["sha256"],
        "device_count": meta["device_count"],
        "model_index_count": meta["model_index_count"],
        "fingerprint_index_count": meta["fingerprint_index_count"],
        "index_entry_size": INDEX_ENTRY_SIZE,
        "search_algorithm": "binary_search_fnv1a_32"
    }

    with open(out_manifest, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)
    print(f"[Binary Compiler v3] Manifest written to {out_manifest}")

if __name__ == "__main__":
    input_dir = sys.argv[1] if len(sys.argv) > 1 else "build_ir"
    out_bin = sys.argv[2] if len(sys.argv) > 2 else "dist/z2m_bundle.bin"
    out_manifest = sys.argv[3] if len(sys.argv) > 3 else "dist/z2m_manifest.json"
    compile_bundle(input_dir, out_bin, out_manifest)
