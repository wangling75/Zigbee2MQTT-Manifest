#pragma once

#include "converter_types.h"
#include <string>

namespace z2m {

class ValueTransformer {
public:
    // Decode raw ZCL byte buffer to double/bool/string based on dataType
    static bool decodeRawZclValue(uint8_t datatype, const uint8_t* data, size_t len, double& out_num, bool& out_bool, std::string& out_str);

    // Apply scaling and offset: result = (value * scale) + offset
    static double applyScaleOffset(double value, float scale, float offset);

    // Lookup enum in map string like {"0":"off","1":"heat","2":"cool"}
    static std::string lookupEnum(const std::string& map_json, int64_t enum_val);

    // Extract bitfield mask
    static uint32_t extractBitfield(uint32_t value, uint32_t mask, uint8_t shift);
};

} // namespace z2m
