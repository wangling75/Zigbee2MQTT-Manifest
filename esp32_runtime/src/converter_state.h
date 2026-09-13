#pragma once

#include "converter_types.h"
#include <string>
#include <unordered_map>

namespace z2m {

class DeviceStateCache {
public:
    DeviceStateCache() = default;

    void updateProperty(uint64_t ieee_addr, const std::string& property, const PropertyValue& value);
    bool getProperty(uint64_t ieee_addr, const std::string& property, PropertyValue& out_value) const;

    // Build MQTT / Home Assistant JSON state payload
    std::string buildJsonPayload(uint64_t ieee_addr) const;

    void clear(uint64_t ieee_addr);

private:
    std::unordered_map<uint64_t, std::unordered_map<std::string, PropertyValue>> states_;
};

} // namespace z2m
