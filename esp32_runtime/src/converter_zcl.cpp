#include "converter_zcl.h"
#include "converter_transform.h"

namespace z2m {

ConverterZcl::ConverterZcl(const ConverterBundle& bundle) : bundle_(bundle) {}

bool ConverterZcl::decodeAttributeReport(const MatchedConverter& converter,
                                         const ZclAttributeReport& report,
                                         std::string& out_property,
                                         PropertyValue& out_value) {
    for (const auto& fz : converter.fz_rules) {
        if (fz.cluster_id != report.cluster_id || fz.attr_id != report.attribute_id) {
            continue;
        }

        double num_val = 0.0;
        bool bool_val = false;
        std::string str_val;

        if (!ValueTransformer::decodeRawZclValue(fz.datatype, report.raw_data, report.raw_len,
                                                 num_val, bool_val, str_val)) {
            continue;
        }

        out_property = bundle_.getString(fz.target_str_offset);
        if (out_property.empty()) {
            out_property = "prop_" + std::to_string(report.cluster_id) + "_" + std::to_string(report.attribute_id);
        }

        // Apply scale & offset
        if (fz.datatype == static_cast<uint8_t>(DataType::BOOL)) {
            out_value.type = PropertyValue::TYPE_BOOL;
            out_value.bool_val = bool_val;
        } else {
            double final_val = ValueTransformer::applyScaleOffset(num_val, fz.scale, fz.offset);
            out_value.type = PropertyValue::TYPE_FLOAT;
            out_value.float_val = final_val;
            out_value.int_val = static_cast<int64_t>(final_val);
        }
        return true;
    }

    return false;
}

bool ConverterZcl::buildCommand(const MatchedConverter& converter,
                                const std::string& property,
                                const PropertyValue& target_value,
                                uint8_t target_endpoint,
                                ZigbeeCommand& out_cmd) {
    for (const auto& tz : converter.tz_rules) {
        std::string field = bundle_.getString(tz.target_str_offset);
        if (field != property) continue;

        out_cmd.endpoint = (target_endpoint > 0) ? target_endpoint : 1;
        out_cmd.cluster_id = tz.cluster_id;

        if (tz.op == static_cast<uint8_t>(Opcode::COMMAND)) {
            out_cmd.is_write_attr = false;
            // On/Off State command
            if (tz.cluster_id == 0x0006) {
                if (target_value.type == PropertyValue::TYPE_BOOL) {
                    out_cmd.command_id = target_value.bool_val ? tz.cmd_on : tz.cmd_off;
                } else if (target_value.type == PropertyValue::TYPE_STRING) {
                    if (target_value.str_val == "ON" || target_value.str_val == "on" || target_value.str_val == "true") {
                        out_cmd.command_id = tz.cmd_on;
                    } else if (target_value.str_val == "OFF" || target_value.str_val == "off" || target_value.str_val == "false") {
                        out_cmd.command_id = tz.cmd_off;
                    } else {
                        out_cmd.command_id = tz.cmd_or_attr; // Toggle
                    }
                } else {
                    out_cmd.command_id = tz.cmd_or_attr;
                }
            } else if (tz.cluster_id == 0x0008) { // Level control (Brightness)
                out_cmd.command_id = tz.cmd_or_attr; // 0x04 MoveToLevelWithOnOff
                uint8_t level = static_cast<uint8_t>(target_value.float_val);
                uint16_t transition = 10; // 1 second
                out_cmd.payload.push_back(level);
                out_cmd.payload.push_back(transition & 0xFF);
                out_cmd.payload.push_back((transition >> 8) & 0xFF);
            } else {
                out_cmd.command_id = static_cast<uint8_t>(tz.cmd_or_attr);
            }
            return true;
        } else if (tz.op == static_cast<uint8_t>(Opcode::WRITE_ATTR)) {
            out_cmd.is_write_attr = true;
            out_cmd.attribute_id = tz.cmd_or_attr;
            int16_t scaled_val = static_cast<int16_t>(target_value.float_val * tz.scale);
            out_cmd.payload.push_back(scaled_val & 0xFF);
            out_cmd.payload.push_back((scaled_val >> 8) & 0xFF);
            return true;
        }
    }

    return false;
}

} // namespace z2m
