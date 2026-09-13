#include "converter_tuya.h"
#include "converter_transform.h"

namespace z2m {

ConverterTuya::ConverterTuya(const ConverterBundle& bundle) : bundle_(bundle) {}

bool ConverterTuya::parseTuyaRawFrame(const uint8_t* payload, size_t len, TuyaDpMessage& out_msg) {
    // Tuya cluster 0xEF00 frame structure:
    // seq: 2 bytes (or status: 1 byte, seq: 1 byte)
    // dp: 1 byte
    // type: 1 byte (0:raw, 1:bool, 2:value 4B BE, 3:string, 4:enum 1B, 5:bitmap)
    // len: 2 bytes Big Endian
    // data: len bytes
    if (!payload || len < 6) return false;

    // Byte 0-1: sequence
    out_msg.dp_id = payload[2];
    out_msg.dp_type = payload[3];
    uint16_t data_len = (payload[4] << 8) | payload[5];

    if (len < static_cast<size_t>(6 + data_len)) return false;

    const uint8_t* data = payload + 6;

    if (out_msg.dp_type == 1 && data_len >= 1) { // bool
        out_msg.value = data[0] ? 1 : 0;
    } else if (out_msg.dp_type == 2 && data_len >= 4) { // value (uint32 BE)
        out_msg.value = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
    } else if (out_msg.dp_type == 4 && data_len >= 1) { // enum
        out_msg.value = data[0];
    } else if (out_msg.dp_type == 3) { // string
        out_msg.str_value = std::string(reinterpret_cast<const char*>(data), data_len);
    }

    out_msg.raw_bytes.assign(data, data + data_len);
    return true;
}

bool ConverterTuya::decodeTuyaDp(const MatchedConverter& converter,
                                 const TuyaDpMessage& msg,
                                 std::string& out_property,
                                 PropertyValue& out_value) {
    for (const auto& dp_rule : converter.tuya_dps) {
        if (dp_rule.dp_id != msg.dp_id) continue;

        out_property = bundle_.getString(dp_rule.target_str_offset);
        if (out_property.empty()) {
            out_property = "dp_" + std::to_string(msg.dp_id);
        }

        if (dp_rule.datatype == 1) { // enum
            std::string map_str = bundle_.getString(dp_rule.map_str_offset);
            std::string enum_name = ValueTransformer::lookupEnum(map_str, msg.value);
            out_value.type = PropertyValue::TYPE_STRING;
            out_value.str_val = enum_name;
            out_value.int_val = msg.value;
            return true;
        } else if (dp_rule.datatype == 2) { // bool
            out_value.type = PropertyValue::TYPE_BOOL;
            out_value.bool_val = (msg.value != 0);
            return true;
        } else if (dp_rule.datatype == 4) { // string
            out_value.type = PropertyValue::TYPE_STRING;
            out_value.str_val = msg.str_value;
            return true;
        } else { // numeric value
            double raw = static_cast<double>(msg.value);
            double final_val = ValueTransformer::applyScaleOffset(raw, dp_rule.scale, dp_rule.offset);
            out_value.type = PropertyValue::TYPE_FLOAT;
            out_value.float_val = final_val;
            out_value.int_val = static_cast<int64_t>(final_val);
            return true;
        }
    }

    return false;
}

bool ConverterTuya::buildTuyaWriteCommand(const MatchedConverter& converter,
                                          const std::string& property,
                                          const PropertyValue& target_value,
                                          uint8_t endpoint,
                                          uint16_t seq,
                                          ZigbeeCommand& out_cmd) {
    for (const auto& dp_rule : converter.tuya_dps) {
        std::string name = bundle_.getString(dp_rule.target_str_offset);
        if (name != property) continue;

        out_cmd.endpoint = (endpoint > 0) ? endpoint : 1;
        out_cmd.cluster_id = 0xEF00;
        out_cmd.command_id = 0x00; // Data request command
        out_cmd.is_write_attr = false;

        // Construct Tuya frame: seq(2B), dp(1B), type(1B), len(2B), data(...)
        out_cmd.payload.push_back((seq >> 8) & 0xFF);
        out_cmd.payload.push_back(seq & 0xFF);
        out_cmd.payload.push_back(dp_rule.dp_id);

        if (dp_rule.datatype == 2) { // bool
            out_cmd.payload.push_back(1); // type bool
            out_cmd.payload.push_back(0); // len msb
            out_cmd.payload.push_back(1); // len lsb
            out_cmd.payload.push_back(target_value.bool_val ? 1 : 0);
        } else if (dp_rule.datatype == 1) { // enum
            out_cmd.payload.push_back(4); // type enum
            out_cmd.payload.push_back(0);
            out_cmd.payload.push_back(1);
            out_cmd.payload.push_back(static_cast<uint8_t>(target_value.int_val));
        } else { // value (4B BE)
            uint32_t val = static_cast<uint32_t>(target_value.float_val / (dp_rule.scale ? dp_rule.scale : 1.0f));
            out_cmd.payload.push_back(2); // type value
            out_cmd.payload.push_back(0);
            out_cmd.payload.push_back(4);
            out_cmd.payload.push_back((val >> 24) & 0xFF);
            out_cmd.payload.push_back((val >> 16) & 0xFF);
            out_cmd.payload.push_back((val >> 8) & 0xFF);
            out_cmd.payload.push_back(val & 0xFF);
        }
        return true;
    }

    return false;
}

} // namespace z2m
