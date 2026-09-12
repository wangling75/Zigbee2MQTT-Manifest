#!/usr/bin/env python3
"""
Z2M Binary Bundle Compiler for ESP32 Gateway (v1.8.0 Platform Architecture)
Compiles Zigbee2MQTT device definitions into a compact, zero-RAM, binary bundle
with a 32-byte fixed-length sorted index table for O(log N) flash binary search.
"""

import os
import sys
import json
import struct
import hashlib
from typing import List, Dict, Any

MAGIC = b"Z2MB"
FORMAT_VERSION = 2
INDEX_ENTRY_SIZE = 32

def fnv1a_32(text: str) -> int:
    """Standard FNV-1a 32-bit hash for fast lowercase string matching."""
    h = 0x811C9DC5
    for b in text.lower().strip().encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def category_to_enum(cat: str) -> int:
    mapping = {
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
        "window_covering": 14
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

class BinaryBundleBuilder:
    def __init__(self):
        self.devices = []
        self.string_table = bytearray()
        self.string_map = {}
        self.seen_models = set()

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

    def add_device(self, dev: Dict[str, Any]):
        model = dev.get("model", "")
        if not model or model in self.seen_models:
            return
        self.seen_models.add(model)

        mfg = dev.get("vendor", "") or dev.get("manufacturer", "")
        category = dev.get("category", "") or dev.get("matter_type", "") or dev.get("homekit_type", "")
        cat_enum = category_to_enum(category)

        # Flags: bit0: is_tuya, bit1: is_battery, bit2: is_multiep
        flags = 0
        desc = dev.get("description", "").lower()
        if "tuya" in str(mfg).lower() or dev.get("is_tuya") or "_tz" in str(mfg).lower():
            flags |= 0x0001
        if cat_enum in (6, 7, 8, 9, 10, 11, 12) or "battery" in desc:
            flags |= 0x0002
        if dev.get("endpoints") and len(dev.get("endpoints")) > 1:
            flags |= 0x0004

        self.devices.append({
            "model": model,
            "mfg": mfg,
            "model_hash": fnv1a_32(model),
            "mfg_hash": fnv1a_32(mfg) if mfg else 0,
            "cat_enum": cat_enum,
            "flags": flags,
            "fromZigbee": dev.get("fromZigbee", []),
            "toZigbee": dev.get("toZigbee", []),
            "exposes": dev.get("exposes", [])
        })

    def build(self, out_bin_path: str) -> Dict[str, Any]:
        # Sort devices strictly by model_hash for fast binary search on Flash
        self.devices.sort(key=lambda d: d["model_hash"])
        dev_count = len(self.devices)

        # Pre-allocate data buffer
        data_buffer = bytearray()
        index_entries = []

        for d in self.devices:
            rec_start = len(data_buffer)

            model_off = self.add_string(d["model"])
            mfg_off = self.add_string(d["mfg"])
            fz_list = d["fromZigbee"]
            tz_list = d["toZigbee"]
            exp_list = d["exposes"]

            # Record Header (16 bytes aligned)
            rec_header = struct.pack(
                "<IIHHHH",
                model_off,
                mfg_off,
                len(fz_list),
                len(tz_list),
                len(exp_list),
                0  # reserved
            )
            data_buffer.extend(rec_header)

            # Encode fromZigbee rules (Cluster: uint16, Attr: uint16, Ep: uint8, DType: uint8, ExposeStrOff: uint16, Multiply: float) = 14 bytes
            for fz in fz_list:
                cl = to_int(fz.get("cluster", 0))
                at = to_int(fz.get("attr", 0))
                ep = to_int(fz.get("endpoint", 0))
                exp_off = self.add_string(str(fz.get("expose_to", "")))
                mul = to_float(fz.get("multiply", 1.0))
                rule_bytes = struct.pack("<HHBBHf", cl, at, ep, 0, exp_off, mul)
                data_buffer.extend(rule_bytes)

            # Encode toZigbee rules (FieldStrOff: uint16, ZclCluster: uint16, ZclCmd: uint8, DpId: uint8, DpType: uint8, Pad: uint8, Mul: float) = 12 bytes
            for tz in tz_list:
                f_off = self.add_string(str(tz.get("field", "")))
                cl = to_int(tz.get("zcl_cluster", 0))
                cmd = to_int(tz.get("zcl_cmd", 0))
                dp_id = to_int(tz.get("dp_id", 0))
                dp_type = to_int(tz.get("dp_type", 0))
                mul = to_float(tz.get("multiply", 1.0))
                tz_bytes = struct.pack("<HHBBBBf", f_off, cl, cmd, dp_id, dp_type, 0, mul)
                data_buffer.extend(tz_bytes)

            # Encode exposes list
            for exp in exp_list:
                if isinstance(exp, str):
                    p_off = self.add_string(exp)
                    data_buffer.extend(struct.pack("<HBBH", p_off, 1, 3, 0))
                elif isinstance(exp, dict):
                    p_off = self.add_string(str(exp.get("property", "")))
                    u_off = self.add_string(str(exp.get("unit", "")))
                    acc = 3 if exp.get("access", "rw") == "rw" else 1
                    data_buffer.extend(struct.pack("<HBBH", p_off, 2, acc, u_off))

            rec_len = len(data_buffer) - rec_start

            # Index entry (Fixed 32 bytes)
            entry = struct.pack(
                "<IIIIHHHHQQ",
                d["model_hash"],
                d["mfg_hash"],
                rec_start,
                rec_len,
                d["cat_enum"],
                d["flags"],
                len(exp_list),
                0,
                0, 0
            )[:INDEX_ENTRY_SIZE]
            index_entries.append(entry)

        index_bytes = b"".join(index_entries)

        idx_offset = 64
        data_offset = idx_offset + len(index_bytes)
        str_offset = data_offset + len(data_buffer)
        total_size = str_offset + len(self.string_table)

        payload = index_bytes + data_buffer + self.string_table
        sha256_raw = hashlib.sha256(payload).digest()

        header = struct.pack(
            "<4sHIIIII32s",
            MAGIC,
            FORMAT_VERSION,
            dev_count,
            idx_offset,
            data_offset,
            str_offset,
            total_size,
            sha256_raw
        ).ljust(64, b'\x00')

        full_binary = header + payload

        with open(out_bin_path, "wb") as f:
            f.write(full_binary)

        print(f"Successfully compiled Binary Bundle: {out_bin_path}")
        print(f"  - Device Count: {dev_count}")
        print(f"  - Total Size: {len(full_binary)} bytes ({len(full_binary)/1024:.2f} KB)")
        print(f"  - Index Table: {len(index_bytes)} bytes ({dev_count} x {INDEX_ENTRY_SIZE} bytes)")
        print(f"  - String Table: {len(self.string_table)} bytes")
        print(f"  - SHA256: {hashlib.sha256(full_binary).hexdigest()}")

        return {
            "version": FORMAT_VERSION,
            "device_count": dev_count,
            "bytes": len(full_binary),
            "sha256": hashlib.sha256(full_binary).hexdigest(),
            "index_entry_size": INDEX_ENTRY_SIZE
        }

def compile_from_json_sources(data_dir: str, out_bin: str, out_manifest: str):
    builder = BinaryBundleBuilder()
    
    # 1. Ingest built-in converters in data/converters/zigbee/
    conv_dir = os.path.join(data_dir, "converters", "zigbee")
    if os.path.isdir(conv_dir):
        for fname in sorted(os.listdir(conv_dir)):
            if fname.endswith(".json"):
                fpath = os.path.join(conv_dir, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    models = data.get("models", [])
                    if isinstance(models, str): models = [models]
                    for m in models:
                        dev = {
                            "model": m,
                            "vendor": data.get("manufacturer", ""),
                            "category": data.get("matter_type", "") or data.get("homekit_type", ""),
                            "description": data.get("description", ""),
                            "fromZigbee": data.get("fromZigbee", []),
                            "toZigbee": data.get("toZigbee", []),
                            "exposes": data.get("exposes", [])
                        }
                        builder.add_device(dev)
                except Exception as e:
                    print(f"Error loading {fpath}: {e}")

    # 2. Ingest z2m_bundle.json or z2m_bundle.ndjson if present (JSONL)
    bundle_path = os.path.join(data_dir, "z2m_bundle.json")
    if not os.path.exists(bundle_path):
        bundle_path = os.path.join(data_dir, "z2m_bundle.ndjson")
    if os.path.exists(bundle_path):
        try:
            with open(bundle_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        dev_def = json.loads(line)
                        models = dev_def.get("models", [])
                        if isinstance(models, str): models = [models]
                        mfg = dev_def.get("vendor", "") or dev_def.get("manufacturer", "")
                        if isinstance(mfg, list) and mfg: mfg = mfg[0]
                        cat = dev_def.get("matter_type", "") or dev_def.get("homekit_type", "")
                        for m in models:
                            dev = {
                                "model": m,
                                "vendor": mfg,
                                "category": cat,
                                "description": dev_def.get("description", ""),
                                "fromZigbee": dev_def.get("fromZigbee", []),
                                "toZigbee": dev_def.get("toZigbee", []),
                                "exposes": dev_def.get("exposes", [])
                            }
                            builder.add_device(dev)
                    except Exception as err:
                        pass
        except Exception as e:
            print(f"Error reading {bundle_path}: {e}")

    # 3. Ingest z2m_index.json for any models not yet present
    idx_path = os.path.join(data_dir, "z2m_index.json")
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                idx_data = json.load(f)
            for model, val in idx_data.items():
                if model in builder.seen_models:
                    continue
                dev = {
                    "model": model,
                    "vendor": "",
                    "category": "",
                    "description": str(val),
                    "fromZigbee": [],
                    "toZigbee": []
                }
                builder.add_device(dev)
        except Exception as e:
            print(f"Error loading {idx_path}: {e}")

    meta = builder.build(out_bin)

    manifest = {
        "format": "z2m-binary-bundle-v2",
        "version": "2.1.0",
        "bundle_version": "2.1.0",
        "ir_version": 2,
        "min_firmware": "v2.1.0",
        "bundle": os.path.basename(out_bin),
        "bytes": meta["bytes"],
        "sha256": meta["sha256"],
        "device_count": meta["device_count"],
        "index_entry_size": INDEX_ENTRY_SIZE,
        "search_algorithm": "binary_search_fnv1a_32"
    }

    with open(out_manifest, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Generated manifest: {out_manifest}")

if __name__ == "__main__":
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "data"
    out_bin = sys.argv[2] if len(sys.argv) > 2 else "data/z2m_bundle.bin"
    out_manifest = sys.argv[3] if len(sys.argv) > 3 else "data/z2m_manifest_bin.json"
    compile_from_json_sources(data_dir, out_bin, out_manifest)
