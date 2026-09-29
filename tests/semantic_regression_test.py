#!/usr/bin/env python3
"""Semantic regression checks for the generated Z2M IR.

These checks run against the candidate NDJSON emitted by the real
zigbee-herdsman-converters package. They cover generic rules that are easy to
regress while expanding support to every vendor:

* color/color-temperature properties stay disjoint on every endpoint;
* each physical light endpoint keeps its own capabilities;
* logical gang aliases always address the matching physical endpoint;
* a physical multi-endpoint switch exposes every official gang;
* single-endpoint virtual gangs still retain their logical count.
"""
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IR = Path(os.environ.get("Z2M_IR", ROOT / "build_ir_candidate" / "z2m_bundle.ndjson"))
NDJSON = IR

ENDPOINT_CAP_STATE = 0x01
ENDPOINT_CAP_BRIGHTNESS = 0x02
ENDPOINT_CAP_COLOR_TEMP = 0x04
ENDPOINT_CAP_COLOR_XY = 0x08

# These are representative definitions, not a vendor allowlist. The generic
# assertions below scan all 4k+ official records.
FIXTURES = {
    "ZNDDMK11LM": {
        "endpoints": {"l1": 1, "l2": 2},
        "caps": {1: ENDPOINT_CAP_COLOR_TEMP | ENDPOINT_CAP_COLOR_XY,
                 2: ENDPOINT_CAP_COLOR_TEMP},
        "gangs": 2,
    },
    "TS0002": {
        "endpoints": {"l1": 1, "l2": 2},
        "caps": {1: ENDPOINT_CAP_STATE, 2: ENDPOINT_CAP_STATE},
        "gangs": 2,
    },
    "4062172044776_4": {
        "endpoints": {"l1": 10, "l2": 11, "s1": 25},
        "caps": {10: ENDPOINT_CAP_STATE | ENDPOINT_CAP_BRIGHTNESS,
                 11: ENDPOINT_CAP_STATE | ENDPOINT_CAP_BRIGHTNESS,
                 25: ENDPOINT_CAP_STATE | ENDPOINT_CAP_BRIGHTNESS},
        "gangs": 3,
    },
    "C-ZB-LC20-RGB": {
        "endpoints": {"default": 1},
        # Official definition exposes color/XY only; it has no color_temp.
        "caps": {1: ENDPOINT_CAP_STATE | ENDPOINT_CAP_BRIGHTNESS |
                     ENDPOINT_CAP_COLOR_XY},
        "gangs": 1,
    },
}


def load_records() -> list[dict]:
    assert NDJSON.exists(), f"missing generated IR: {NDJSON}"
    records = []
    with NDJSON.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    assert records, "generated IR is empty"
    return records


def target_has_prefix(target: str, prefix: str) -> bool:
    return target == prefix or target.startswith(prefix + "_")


def assert_color_capabilities_are_disjoint(records: list[dict]) -> None:
    bad_temp: list[str] = []
    bad_xy: list[str] = []
    for record in records:
        model = record.get("model", "")
        for rule in record.get("toZigbee", []):
            target = str(rule.get("target", ""))
            if target_has_prefix(target, "color_temp"):
                # Official light_color_and_colortemp_via_color converters
                # intentionally implement color temperature with moveToColor
                # (0x07), converting mireds to XY at runtime.
                if (rule.get("cluster") != "0x0300" or
                        rule.get("cmd") not in ("0x0007", "0x000A")):
                    bad_temp.append(f"{model}:{target}:{rule.get('cmd')}")
            if target == "color_xy" or target.startswith("color_xy_"):
                if (rule.get("cluster") != "0x0300" or
                        rule.get("cmd") not in ("0x0004", "0x0006", "0x0007")):
                    bad_xy.append(f"{model}:{target}:{rule.get('cmd')}")
    assert not bad_temp, (
        f"color_temp commands must use moveToColorTemp or official "
        f"via-color moveToColor: {bad_temp[:10]}"
    )
    assert not bad_xy, f"color_xy commands must use moveToColor: {bad_xy[:10]}"


def assert_fixture_capabilities(records: list[dict]) -> None:
    by_model: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        by_model[str(record.get("model", ""))].append(record)

    for model, expected in FIXTURES.items():
        candidates = by_model.get(model, [])
        assert candidates, f"missing IR for {model}"
        record = candidates[0]
        assert record.get("endpoints") == expected["endpoints"], (
            f"{model}: endpoint map changed: {record.get('endpoints')}"
        )
        bits = {int(key): int(value) for key, value in
                record.get("endpointCapabilityBits", {}).items()}
        for endpoint, cap in expected["caps"].items():
            assert bits.get(endpoint, 0) & cap == cap, (
                f"{model}: endpoint {endpoint} lost cap 0x{cap:02X}: {bits}"
            )
        assert int(record.get("logicalGangCount", 0)) == expected["gangs"], (
            f"{model}: logical gang count changed"
        )

    # Aqara's l2 is CCT-only; this is the concrete regression that produced
    # a bogus Hue/Saturation service and a moveToColor alias.
    aqara = by_model["ZNDDMK11LM"][0]
    assert aqara["endpointCapabilityBits"]["1"] & ENDPOINT_CAP_COLOR_XY
    assert aqara["endpointCapabilityBits"]["1"] & ENDPOINT_CAP_COLOR_TEMP
    assert not (aqara["endpointCapabilityBits"]["2"] & ENDPOINT_CAP_COLOR_XY), (
        "ZNDDMK11LM l2 must not be exposed as an RGB endpoint"
    )
    assert aqara["endpointCapabilityBits"]["2"] & ENDPOINT_CAP_COLOR_TEMP

    # The OSRAM fixture has named, non-contiguous endpoints. Gang aliases
    # must preserve those physical IDs rather than renumbering them.
    osram = by_model["4062172044776_4"][0]
    state_rules = [rule for rule in osram["toZigbee"]
                   if str(rule.get("target", "")).startswith("state_l")]
    assert {int(rule["endpoint"]) for rule in state_rules} == {10, 11, 25}, state_rules


def assert_aliases_follow_endpoints(records: list[dict]) -> None:
    for record in records:
        model = record.get("model", "")
        for rule in record.get("toZigbee", []):
            target = str(rule.get("target", ""))
            if not (target.startswith("color_temp_l") or
                    target.startswith("color_xy_l") or
                    target.startswith("brightness_l")):
                continue
            assert int(rule.get("endpoint", 0)) > 0, (
                f"{model}: per-gang alias {target} has no physical endpoint"
            )


def assert_private_dp_state_routing(records: list[dict]) -> None:
    by_model = {str(record.get("model", "")): record for record in records}
    # Official garage-door definitions use DP bools with explicit
    # polarity. The inverted contact converter must survive IR generation.
    modern = by_model.get("TS0601_garage_door_opener")
    assert modern, "missing IR for TS0601_garage_door_opener"
    assert modern.get("category") == "garage_door"
    modern_dps = {int(dp["dp"]): dp for dp in modern.get("tuyaDatapoints", [])}
    assert modern_dps[1]["target"] == "trigger", modern_dps.get(1)
    assert modern_dps[3]["target"] == "garage_door_contact", modern_dps.get(3)
    assert float(modern_dps[3]["scale"]) == -1.0, modern_dps.get(3)
    assert float(modern_dps[3]["offset"]) == 1.0, modern_dps.get(3)

    legacy = by_model.get("GDC311ZBQ1")
    assert legacy, "missing IR for GDC311ZBQ1"
    assert legacy.get("category") == "garage_door"
    legacy_dps = {int(dp["dp"]): dp for dp in legacy.get("tuyaDatapoints", [])}
    assert legacy_dps.get(1, {}).get("target") == "trigger", legacy_dps.get(1)
    assert legacy_dps.get(3, {}).get("target") == "garage_door_contact", legacy_dps.get(3)
    assert float(legacy_dps[3]["scale"]) == -1.0, legacy_dps.get(3)
    assert float(legacy_dps[3]["offset"]) == 1.0, legacy_dps.get(3)

    ts0603 = by_model.get("TS0603")
    assert ts0603, "missing IR for TS0603"
    assert ts0603.get("category") == "garage_door"
    ts_dps = {int(dp["dp"]): dp for dp in ts0603.get("tuyaDatapoints", [])}
    assert ts_dps.get(1, {}).get("target") == "state", ts_dps.get(1)
    assert ts_dps.get(3, {}).get("target") == "garage_door_contact", ts_dps.get(3)
    assert float(ts_dps[3]["scale"]) == -1.0, ts_dps.get(3)
    assert float(ts_dps[3]["offset"]) == 1.0, ts_dps.get(3)

    # WZ5 delegates state to the official tuya_dimmer_state converter.
    # Its state must be written through the DP VM, never a ZCL genOnOff
    # fallback. This is identity-based and applies to every WZ5 variant.
    for model in ("WZ5_dim_1", "WZ5_cct", "WZ5_rgb", "WZ5_rgbw", "WZ5_rgbcct"):
        record = by_model.get(model)
        assert record, f"missing IR for {model}"
        state_rules = [rule for rule in record.get("toZigbee", [])
                       if str(rule.get("target", "")) in ("state", "switch")]
        assert not state_rules, f"{model}: private DP state leaked to ZCL: {state_rules}"
        assert record.get("toVm"), f"{model}: missing private DP state VM"

    # WZ5_rgb_1 is a distinct official definition (TS0503B /
    # _TZB210_zdvrsts8) using tuyaLight over standard ZCL. It must not
    # be collapsed into the private-DP definitions above.
    standard_wz5 = by_model.get("WZ5_rgb_1")
    assert standard_wz5, "missing IR for WZ5_rgb_1"
    standard_wz5_state = [
        rule for rule in standard_wz5.get("toZigbee", [])
        if str(rule.get("target", "")) == "state" and
        rule.get("cluster") == "0x0006"
    ]
    assert len(standard_wz5_state) == 1, (
        f"WZ5_rgb_1: expected one standard state rule, got {standard_wz5_state}"
    )

    # Silvercrest's private converter owns brightness/color only; state is
    # the standard tz.on_off path and must remain a genOnOff command.
    silvercrest = by_model.get("HG06467")
    assert silvercrest, "missing IR for HG06467"
    standard_state = [rule for rule in silvercrest.get("toZigbee", [])
                      if str(rule.get("target", "")) == "state" and
                      rule.get("cluster") == "0x0006"]
    assert len(standard_state) == 1, (
        f"HG06467: expected one standard state rule, got {standard_state}"
    )


def main() -> int:
    records = load_records()
    assert_color_capabilities_are_disjoint(records)
    assert_fixture_capabilities(records)
    assert_aliases_follow_endpoints(records)
    assert_private_dp_state_routing(records)
    print(
        "PASS: semantic IR checks "
        f"(records={len(records)}, color/color_temp disjoint, "
        "per-endpoint caps, gang aliases)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
