#include "converter_state.h"

namespace z2m {

void DeviceStateCache::updateProperty(uint64_t ieee_addr, const std::string& property, const PropertyValue& value) {
    states_[ieee_addr][property] = value;
}

bool DeviceStateCache::getProperty(uint64_t ieee_addr, const std::string& property, PropertyValue& out_value) const {
    auto dev_it = states_.find(ieee_addr);
    if (dev_it == states_.end()) return false;
    auto prop_it = dev_it->second.find(property);
    if (prop_it == dev_it->second.end()) return false;
    out_value = prop_it->second;
    return true;
}

std::string DeviceStateCache::buildJsonPayload(uint64_t ieee_addr) const {
    auto dev_it = states_.find(ieee_addr);
    if (dev_it == states_.end() || dev_it->second.empty()) return "{}";

    std::string json = "{";
    bool first = true;
    for (const auto& kv : dev_it->second) {
        if (!first) json += ",";
        first = false;
        json += "\"" + kv.first + "\":";
        if (kv.second.type == PropertyValue::TYPE_BOOL) {
            json += kv.second.bool_val ? "true" : "false";
        } else if (kv.second.type == PropertyValue::TYPE_STRING) {
            json += "\"" + kv.second.str_val + "\"";
        } else if (kv.second.type == PropertyValue::TYPE_INT) {
            json += std::to_string(kv.second.int_val);
        } else if (kv.second.type == PropertyValue::TYPE_FLOAT) {
            char buf[32];
            snprintf(buf, sizeof(buf), "%.2f", kv.second.float_val);
            json += buf;
        } else {
            json += "null";
        }
    }
    json += "}";
    return json;
}

void DeviceStateCache::clear(uint64_t ieee_addr) {
    states_.erase(ieee_addr);
}

} // namespace z2m
