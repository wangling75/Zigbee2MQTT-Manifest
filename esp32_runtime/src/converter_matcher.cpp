#include "converter_matcher.h"

namespace z2m {

ConverterMatcher::ConverterMatcher(const ConverterBundle& bundle) : bundle_(bundle) {}

bool ConverterMatcher::findByModel(const std::string& model, IndexEntry& out_entry, uint32_t* seek_count) {
    if (!bundle_.isValid() || model.empty()) return false;
    uint32_t target_hash = hash_fnv1a(model);

    int32_t low = 0;
    int32_t high = static_cast<int32_t>(bundle_.header().model_idx_count) - 1;
    uint32_t seeks = 0;

    while (low <= high) {
        int32_t mid = low + (high - low) / 2;
        seeks++;
        IndexEntry entry;
        if (!bundle_.readModelIndexEntry(mid, entry)) break;

        if (entry.hash == target_hash) {
            if (seek_count) *seek_count = seeks;
            out_entry = entry;
            return true;
        } else if (entry.hash < target_hash) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    if (seek_count) *seek_count = seeks;
    return false;
}

bool ConverterMatcher::findByFingerprint(const std::string& mfg, const std::string& model, IndexEntry& out_entry, uint32_t* seek_count) {
    if (!bundle_.isValid() || (mfg.empty() && model.empty())) return false;
    std::string key = mfg + "|" + model;
    uint32_t target_hash = hash_fnv1a(key);

    int32_t low = 0;
    int32_t high = static_cast<int32_t>(bundle_.header().fp_idx_count) - 1;
    uint32_t seeks = 0;

    while (low <= high) {
        int32_t mid = low + (high - low) / 2;
        seeks++;
        IndexEntry entry;
        if (!bundle_.readFpIndexEntry(mid, entry)) break;

        if (entry.hash == target_hash) {
            if (seek_count) *seek_count = seeks;
            out_entry = entry;
            return true;
        } else if (entry.hash < target_hash) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    if (seek_count) *seek_count = seeks;
    return false;
}

bool ConverterMatcher::loadRecordDetails(const IndexEntry& entry, MatchedConverter& out_converter) {
    if (!bundle_.isValid()) return false;

    out_converter.matched = true;
    out_converter.index_entry = entry;
    out_converter.category = static_cast<DeviceCategory>(entry.category);

    RecordHeader hdr;
    if (!bundle_.readRecordHeader(entry.record_offset, hdr)) {
        return false;
    }
    out_converter.record_header = hdr;
    out_converter.model = bundle_.getString(hdr.model_str_offset);
    out_converter.vendor = bundle_.getString(hdr.vendor_str_offset);
    out_converter.description = bundle_.getString(hdr.desc_str_offset);

    auto reader = bundle_.reader();
    size_t cursor = bundle_.header().records_offset + entry.record_offset + sizeof(RecordHeader);

    // 1. Endpoints
    out_converter.endpoints.resize(hdr.ep_count);
    if (hdr.ep_count > 0) {
        reader->read(cursor, out_converter.endpoints.data(), hdr.ep_count * sizeof(EndpointDesc));
        cursor += hdr.ep_count * sizeof(EndpointDesc);
    }

    // 2. fromZigbee Rules
    out_converter.fz_rules.resize(hdr.fz_count);
    if (hdr.fz_count > 0) {
        reader->read(cursor, out_converter.fz_rules.data(), hdr.fz_count * sizeof(FromZigbeeIR));
        cursor += hdr.fz_count * sizeof(FromZigbeeIR);
    }

    // 3. toZigbee Rules
    out_converter.tz_rules.resize(hdr.tz_count);
    if (hdr.tz_count > 0) {
        reader->read(cursor, out_converter.tz_rules.data(), hdr.tz_count * sizeof(ToZigbeeIR));
        cursor += hdr.tz_count * sizeof(ToZigbeeIR);
    }

    // 4. Tuya DP Rules
    out_converter.tuya_dps.resize(hdr.dp_count);
    if (hdr.dp_count > 0) {
        reader->read(cursor, out_converter.tuya_dps.data(), hdr.dp_count * sizeof(TuyaDpIR));
        cursor += hdr.dp_count * sizeof(TuyaDpIR);
    }

    // 5. Reporting configs
    out_converter.reporting_configs.resize(hdr.reporting_count);
    if (hdr.reporting_count > 0) {
        reader->read(cursor, out_converter.reporting_configs.data(), hdr.reporting_count * sizeof(ReportingConfig));
        cursor += hdr.reporting_count * sizeof(ReportingConfig);
    }

    // 6. Binds
    out_converter.binds.resize(hdr.bind_count);
    if (hdr.bind_count > 0) {
        reader->read(cursor, out_converter.binds.data(), hdr.bind_count * sizeof(uint16_t));
        cursor += hdr.bind_count * sizeof(uint16_t);
    }

    return true;
}

bool ConverterMatcher::matchDevice(const DeviceInterview& interview, MatchedConverter& out_converter) {
    IndexEntry entry;

    // Stage 1: Match by Fingerprint
    if (!interview.manufacturer_name.empty() && !interview.model_id.empty()) {
        if (findByFingerprint(interview.manufacturer_name, interview.model_id, entry)) {
            return loadRecordDetails(entry, out_converter);
        }
    }

    // Stage 2: Match by Model ID
    if (!interview.model_id.empty()) {
        if (findByModel(interview.model_id, entry)) {
            return loadRecordDetails(entry, out_converter);
        }
    }

    // Stage 3: Match by Capability Fallback
    // If device interviewed with standard ZCL clusters but model not found in index,
    // construct fallback converter dynamically!
    if (interview.hasInputCluster(0x0006)) { // Switch or Light
        out_converter.matched = true;
        out_converter.model = interview.model_id.empty() ? "Generic_Switch" : interview.model_id;
        out_converter.vendor = interview.manufacturer_name;
        out_converter.category = interview.hasInputCluster(0x0008) ? DeviceCategory::DIMMABLE_LIGHT : DeviceCategory::ON_OFF_SWITCH;
        // Synthesize fallback IR rules
        FromZigbeeIR fz{};
        fz.op = static_cast<uint8_t>(Opcode::READ_ATTR);
        fz.datatype = static_cast<uint8_t>(DataType::BOOL);
        fz.cluster_id = 0x0006;
        fz.attr_id = 0x0000;
        fz.scale = 1.0f;
        out_converter.fz_rules.push_back(fz);

        ToZigbeeIR tz{};
        tz.op = static_cast<uint8_t>(Opcode::COMMAND);
        tz.cluster_id = 0x0006;
        tz.cmd_or_attr = 0x02; // Toggle
        tz.cmd_on = 0x01;
        tz.cmd_off = 0x00;
        out_converter.tz_rules.push_back(tz);
        return true;
    }

    return false;
}

} // namespace z2m
