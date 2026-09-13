#include "converter_runtime.h"
#include "converter_debug.h"
#include "converter_endpoint.h"

namespace z2m {

ConverterRuntime::ConverterRuntime() = default;

bool ConverterRuntime::init(std::shared_ptr<IBundleReader> reader) {
    if (!bundle_.load(reader)) {
        ConverterDebug::log(ConverterDebug::ERROR, "Runtime", "Failed to load bundle header or magic mismatch");
        return false;
    }

    matcher_ = std::make_unique<ConverterMatcher>(bundle_);
    zcl_ = std::make_unique<ConverterZcl>(bundle_);
    tuya_ = std::make_unique<ConverterTuya>(bundle_);

    ConverterDebug::log(ConverterDebug::INFO, "Runtime",
        "Bundle loaded successfully: %u devices, %u models, %u fingerprints, size: %u bytes",
        bundle_.header().device_count,
        bundle_.header().model_idx_count,
        bundle_.header().fp_idx_count,
        bundle_.header().total_size);

    return true;
}

bool ConverterRuntime::handleDeviceInterview(const DeviceInterview& interview) {
    if (!matcher_) return false;

    MatchedConverter converter;
    if (!matcher_->matchDevice(interview, converter)) {
        ConverterDebug::log(ConverterDebug::WARN, "Runtime",
            "Device [IEEE: %llx, Model: '%s', Mfg: '%s'] not recognized by converter bundle",
            interview.ieee_addr, interview.model_id.c_str(), interview.manufacturer_name.c_str());
        return false;
    }

    ConverterDebug::log(ConverterDebug::INFO, "Runtime",
        "Device [IEEE: %llx] matched to converter: '%s' (%s), Category: %d, FZ rules: %zu, TZ rules: %zu, Tuya DPs: %zu",
        interview.ieee_addr, converter.model.c_str(), converter.vendor.c_str(),
        static_cast<int>(converter.category),
        converter.fz_rules.size(), converter.tz_rules.size(), converter.tuya_dps.size());

    active_devices_[interview.ieee_addr] = converter;
    device_interviews_[interview.ieee_addr] = interview;

    // Optional: Log required binds and reporting configs
    auto binds = ConverterReporting::getRequiredBinds(interview, converter);
    ConverterDebug::log(ConverterDebug::DEBUG, "Runtime", "Device needs %zu cluster bindings", binds.size());

    return true;
}

bool ConverterRuntime::isDeviceSupported(uint64_t ieee_addr) const {
    return active_devices_.find(ieee_addr) != active_devices_.end();
}

const MatchedConverter* ConverterRuntime::getDeviceConverter(uint64_t ieee_addr) const {
    auto it = active_devices_.find(ieee_addr);
    if (it != active_devices_.end()) return &it->second;
    return nullptr;
}

bool ConverterRuntime::handleZclReport(uint64_t ieee_addr, const ZclAttributeReport& report) {
    auto it = active_devices_.find(ieee_addr);
    if (it == active_devices_.end()) return false;

    std::string property;
    PropertyValue value;
    if (zcl_->decodeAttributeReport(it->second, report, property, value)) {
        state_cache_.updateProperty(ieee_addr, property, value);
        if (state_callback_) {
            std::string payload = state_cache_.buildJsonPayload(ieee_addr);
            state_callback_(ieee_addr, property, value, payload);
        }
        return true;
    }
    return false;
}

bool ConverterRuntime::handleTuyaFrame(uint64_t ieee_addr, const uint8_t* payload, size_t len) {
    auto it = active_devices_.find(ieee_addr);
    if (it == active_devices_.end()) return false;

    TuyaDpMessage msg;
    if (!ConverterTuya::parseTuyaRawFrame(payload, len, msg)) {
        return false;
    }

    std::string property;
    PropertyValue value;
    if (tuya_->decodeTuyaDp(it->second, msg, property, value)) {
        state_cache_.updateProperty(ieee_addr, property, value);
        if (state_callback_) {
            std::string payload = state_cache_.buildJsonPayload(ieee_addr);
            state_callback_(ieee_addr, property, value, payload);
        }
        return true;
    }
    return false;
}

bool ConverterRuntime::setDeviceProperty(uint64_t ieee_addr, const std::string& property, const PropertyValue& value) {
    auto it = active_devices_.find(ieee_addr);
    if (it == active_devices_.end()) return false;

    auto dev_it = device_interviews_.find(ieee_addr);
    uint16_t short_addr = (dev_it != device_interviews_.end()) ? dev_it->second.short_addr : 0;

    ZigbeeCommand cmd;
    bool built = false;

    // 1. Try Tuya DP command if device has Tuya DPs
    if (!it->second.tuya_dps.empty()) {
        built = tuya_->buildTuyaWriteCommand(it->second, property, value, 1, seq_++, cmd);
    }

    // 2. Try standard ZCL command
    if (!built && !it->second.tz_rules.empty()) {
        uint8_t ep = 1;
        if (dev_it != device_interviews_.end()) {
            ep = EndpointResolver::resolve(dev_it->second, it->second, 0, 0);
        }
        built = zcl_->buildCommand(it->second, property, value, ep, cmd);
    }

    if (built && tx_callback_) {
        return tx_callback_(ieee_addr, short_addr, cmd);
    }

    return built;
}

} // namespace z2m
