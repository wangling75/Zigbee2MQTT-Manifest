#include "converter_transform.h"
#include <cmath>

namespace z2m {

bool ValueTransformer::decodeRawZclValue(uint8_t datatype, const uint8_t* data, size_t len,
                                         double& out_num, bool& out_bool, std::string& /*out_str*/) {
    if (!data || len == 0) return false;

    // Standard ZCL data types or our internal DataType
    if (datatype == static_cast<uint8_t>(DataType::BOOL) || datatype == 0x10) {
        out_bool = (data[0] != 0);
        out_num = out_bool ? 1.0 : 0.0;
        return true;
    }

    if (datatype == static_cast<uint8_t>(DataType::UINT8) || datatype == 0x20 ||
        datatype == static_cast<uint8_t>(DataType::ENUM8) || datatype == 0x30) {
        out_num = static_cast<double>(data[0]);
        out_bool = (data[0] != 0);
        return true;
    }

    if (datatype == static_cast<uint8_t>(DataType::INT16) || datatype == 0x29) {
        if (len < 2) return false;
        int16_t val = static_cast<int16_t>(data[0] | (data[1] << 8));
        out_num = static_cast<double>(val);
        return true;
    }

    if (datatype == static_cast<uint8_t>(DataType::UINT16) || datatype == 0x21) {
        if (len < 2) return false;
        uint16_t val = static_cast<uint16_t>(data[0] | (data[1] << 8));
        out_num = static_cast<double>(val);
        return true;
    }

    if (datatype == static_cast<uint8_t>(DataType::INT32) || datatype == 0x2B) {
        if (len < 4) return false;
        int32_t val = static_cast<int32_t>(data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24));
        out_num = static_cast<double>(val);
        return true;
    }

    if (datatype == static_cast<uint8_t>(DataType::UINT32) || datatype == 0x23) {
        if (len < 4) return false;
        uint32_t val = static_cast<uint32_t>(data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24));
        out_num = static_cast<double>(val);
        return true;
    }

    // Default 1-byte or 2-byte fallback
    if (len == 1) {
        out_num = static_cast<double>(data[0]);
        out_bool = (data[0] != 0);
        return true;
    } else if (len >= 2) {
        uint16_t val = static_cast<uint16_t>(data[0] | (data[1] << 8));
        out_num = static_cast<double>(val);
        return true;
    }

    return false;
}

double ValueTransformer::applyScaleOffset(double value, float scale, float offset) {
    if (scale == 0.0f) scale = 1.0f;
    return (value * static_cast<double>(scale)) + static_cast<double>(offset);
}

std::string ValueTransformer::lookupEnum(const std::string& map_json, int64_t enum_val) {
    if (map_json.empty()) return std::to_string(enum_val);

    // Flexible parser for {"0":"celsius"} or {"0": "celsius"}
    std::string key_str = "\"" + std::to_string(enum_val) + "\"";
    size_t pos = map_json.find(key_str);
    if (pos != std::string::npos) {
        size_t colon = map_json.find(':', pos + key_str.length());
        if (colon != std::string::npos) {
            size_t first_quote = map_json.find('\"', colon);
            if (first_quote != std::string::npos) {
                size_t second_quote = map_json.find('\"', first_quote + 1);
                if (second_quote != std::string::npos) {
                    return map_json.substr(first_quote + 1, second_quote - first_quote - 1);
                }
            }
        }
    }
    return std::to_string(enum_val);
}

uint32_t ValueTransformer::extractBitfield(uint32_t value, uint32_t mask, uint8_t shift) {
    return (value & mask) >> shift;
}

} // namespace z2m
