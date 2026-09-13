#pragma once

#include "converter_bundle.h"
#include "converter_types.h"

namespace z2m {

struct MatchedConverter {
    bool matched = false;
    IndexEntry index_entry;
    RecordHeader record_header;
    std::string model;
    std::string vendor;
    std::string description;
    DeviceCategory category = DeviceCategory::GENERIC;
    std::vector<EndpointDesc> endpoints;
    std::vector<FromZigbeeIR> fz_rules;
    std::vector<ToZigbeeIR> tz_rules;
    std::vector<TuyaDpIR> tuya_dps;
    std::vector<ReportingConfig> reporting_configs;
    std::vector<uint16_t> binds;
};

class ConverterMatcher {
public:
    explicit ConverterMatcher(const ConverterBundle& bundle);

    // Matches device using 3-stage strategy:
    // 1. Fingerprint exact match (manufacturerName|modelID)
    // 2. Model ID match (modelID)
    // 3. Cluster capability fallback match
    bool matchDevice(const DeviceInterview& interview, MatchedConverter& out_converter);

    // Direct binary search by model ID
    bool findByModel(const std::string& model, IndexEntry& out_entry, uint32_t* seek_count = nullptr);

    // Direct binary search by fingerprint (mfg + "|" + model)
    bool findByFingerprint(const std::string& mfg, const std::string& model, IndexEntry& out_entry, uint32_t* seek_count = nullptr);

    // Load full converter record details into memory
    bool loadRecordDetails(const IndexEntry& entry, MatchedConverter& out_converter);

private:
    const ConverterBundle& bundle_;
};

} // namespace z2m
