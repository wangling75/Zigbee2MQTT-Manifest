#pragma once

#include "converter_types.h"
#include "converter_bundle.h"
#include "converter_matcher.h"
#include "converter_zcl.h"
#include "converter_tuya.h"
#include "converter_reporting.h"
#include "converter_state.h"
#include <functional>
#include <memory>
#include <unordered_map>

namespace z2m {

// Callback types for integration with gateway (MQTT / Home Assistant / HomeKit)
using StateChangeCallback = std::function<void(uint64_t ieee_addr, const std::string& property, const PropertyValue& val, const std::string& json_payload)>;
using ZigbeeTxCallback = std::function<bool(uint64_t ieee_addr, uint16_t short_addr, const ZigbeeCommand& cmd)>;

class ConverterRuntime {
public:
    ConverterRuntime();
    ~ConverterRuntime() = default;

    // Load binary bundle from reader (memory or file)
    bool init(std::shared_ptr<IBundleReader> reader);

    // Register callbacks
    void onStateChange(StateChangeCallback cb) { state_callback_ = cb; }
    void onZigbeeTx(ZigbeeTxCallback cb) { tx_callback_ = cb; }

    // Device interview & lifecycle
    bool handleDeviceInterview(const DeviceInterview& interview);
    bool isDeviceSupported(uint64_t ieee_addr) const;
    const MatchedConverter* getDeviceConverter(uint64_t ieee_addr) const;

    // Incoming Zigbee frame processing
    bool handleZclReport(uint64_t ieee_addr, const ZclAttributeReport& report);
    bool handleTuyaFrame(uint64_t ieee_addr, const uint8_t* payload, size_t len);

    // Outgoing control request (from MQTT / Home Assistant / HomeKit)
    bool setDeviceProperty(uint64_t ieee_addr, const std::string& property, const PropertyValue& value);

    // State cache access
    DeviceStateCache& stateCache() { return state_cache_; }
    const ConverterBundle& bundle() const { return bundle_; }

private:
    ConverterBundle bundle_;
    std::unique_ptr<ConverterMatcher> matcher_;
    std::unique_ptr<ConverterZcl> zcl_;
    std::unique_ptr<ConverterTuya> tuya_;
    DeviceStateCache state_cache_;

    std::unordered_map<uint64_t, MatchedConverter> active_devices_;
    std::unordered_map<uint64_t, DeviceInterview> device_interviews_;

    StateChangeCallback state_callback_;
    ZigbeeTxCallback tx_callback_;
    uint16_t seq_ = 1;
};

} // namespace z2m
