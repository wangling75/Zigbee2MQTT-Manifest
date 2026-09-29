#!/usr/bin/env python3
"""Regression checks for official battery semantics in the generated IR."""
from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IR = Path(os.environ.get("Z2M_IR", ROOT / "build_ir_candidate" / "z2m_bundle.ndjson"))


def load_records() -> dict[str, list[dict]]:
    assert IR.exists(), f"missing generated IR: {IR}"
    records: dict[str, list[dict]] = defaultdict(list)
    with IR.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            records[str(record.get("model", ""))].append(record)
    return records


def require(condition: bool, message: str) -> None:
    assert condition, message


def main() -> None:
    records = load_records()

    # Lumi temperature/humidity devices use the legacy Xiaomi private
    # report. Their official voltage curve must be present even though
    # there is no genPowerCfg cluster in the definition.
    for model in ("WSDCGQ11LM", "RTCGQ01LM"):
        candidates = records.get(model, [])
        require(candidates, f"missing IR for {model}")
        semantics = candidates[0].get("batterySemantics")
        require(isinstance(semantics, dict), f"{model}: missing battery semantics")
        require(semantics.get("enabled") is True, f"{model}: battery disabled")
        require(semantics.get("percentage") is True, f"{model}: percentage missing")
        require(semantics.get("voltage") is True, f"{model}: voltage missing")
        require(semantics.get("curve") == 1, f"{model}: expected linear curve")
        require(semantics.get("minVoltage") == 2850, f"{model}: wrong min voltage")
        require(semantics.get("maxVoltage") == 3000, f"{model}: wrong max voltage")

    # WSDCGQ12LM uses genPowerCfg and the same official Lumi curve.
    candidates = records.get("WSDCGQ12LM", [])
    require(candidates, "missing IR for WSDCGQ12LM")
    semantics = candidates[0].get("batterySemantics")
    require(isinstance(semantics, dict), "WSDCGQ12LM: missing battery semantics")
    require(semantics.get("curve") == 1, "WSDCGQ12LM: expected linear curve")
    require(semantics.get("minVoltage") == 2850, "WSDCGQ12LM: wrong min voltage")
    require(semantics.get("maxVoltage") == 3000, "WSDCGQ12LM: wrong max voltage")

    # Modern Lumi battery definitions keep their curve in converter
    # arguments rather than meta. This is the regression that produced no
    # percentage for DJT12LM before the factory metadata bridge.
    candidates = records.get("DJT12LM", [])
    require(candidates, "missing IR for DJT12LM")
    semantics = candidates[0].get("batterySemantics")
    require(isinstance(semantics, dict), "DJT12LM: missing battery semantics")
    require(semantics.get("curve") == 1, "DJT12LM: expected linear curve")
    require(semantics.get("minVoltage") == 2850, "DJT12LM: wrong min voltage")
    require(semantics.get("maxVoltage") == 3000, "DJT12LM: wrong max voltage")

    # lumiBattery() defaults both private attributes to 1. The firmware
    # must publish voltage and derive battery from that same attribute.
    for model in ("DJT12LM", "ZNXNKG02LM"):
        candidates = records.get(model, [])
        require(candidates, f"missing IR for {model}")
        semantics = candidates[0].get("batterySemantics")
        require(isinstance(semantics, dict), f"{model}: missing battery semantics")
        require(semantics.get("privateCluster") == "manuSpecificLumi",
                f"{model}: wrong private battery cluster")
        require(semantics.get("privateVoltageAttribute") == 1,
                f"{model}: wrong private voltage attribute")
        require(semantics.get("privatePercentageAttribute") == 1,
                f"{model}: wrong private percentage attribute")

    # DWZTCGQ11LM uses distinct private voltage/percentage attributes and
    # no curve, so both values are published directly.
    candidates = records.get("DWZTCGQ11LM", [])
    require(candidates, "missing IR for DWZTCGQ11LM")
    semantics = candidates[0].get("batterySemantics")
    require(isinstance(semantics, dict), "DWZTCGQ11LM: missing battery semantics")
    require(semantics.get("privateVoltageAttribute") == 23,
            "DWZTCGQ11LM: wrong private voltage attribute")
    require(semantics.get("privatePercentageAttribute") == 24,
            "DWZTCGQ11LM: wrong private percentage attribute")
    require(semantics.get("curve") == 0, "DWZTCGQ11LM: unexpected curve")

    # A standard ZCL percentage-only device must still publish percentage
    # even when it has no voltage curve.
    candidates = records.get("LDSENK08", [])
    require(candidates, "missing IR for LDSENK08")
    semantics = candidates[0].get("batterySemantics")
    require(isinstance(semantics, dict), "LDSENK08: missing battery semantics")
    require(semantics.get("percentage") is True, "LDSENK08: percentage missing")
    require(semantics.get("curve") == 0, "LDSENK08: unexpected voltage curve")

    print("PASS: official battery semantics regression")


if __name__ == "__main__":
    main()
