#pragma once

#include <stdint.h>
#include <stddef.h>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <unordered_map>

namespace z2m {

#pragma pack(push, 1)

constexpr uint32_t BUNDLE_MAGIC = 0x424D325A; // 'Z2MB' in little-endian
constexpr uint16_t FORMAT_VERSION = 3;
constexpr uint16_t IR_VERSION = 3;
constexpr size_t HEADER_SIZE = 128;
constexpr size_t INDEX_ENTRY_SIZE = 32;

// Binary Bundle Header (128 bytes)
struct BundleHeader {
    char magic[4];             // "Z2MB"
    uint16_t version;          // 3
    uint16_t ir_version;       // 3
    uint32_t device_count;     // Total devices
    uint32_t model_idx_offset; // Byte offset of model index
    uint32_t model_idx_count;  // Count of model index entries
    uint32_t fp_idx_offset;    // Byte offset of fingerprint index
    uint32_t fp_idx_count;     // Count of fingerprint index entries
    uint32_t records_offset;   // Byte offset of records buffer
    uint32_t strings_offset;   // Byte offset of string table
    uint32_t total_size;       // Total size of binary file
    uint32_t crc32;            // CRC32 value
    uint8_t sha256[32];        // SHA256 of payload
    uint8_t reserved[52];      // Pad to 128 bytes
};

// Fixed 32-byte Index Entry for O(log N) binary search
struct IndexEntry {
    uint32_t hash;             // FNV1a-32 hash of model or mfg|model
    uint32_t sec_hash;         // FNV1a-32 hash of vendor
    uint32_t record_offset;    // Relative offset in records section
    uint32_t record_len;       // Total byte size of record
    uint16_t category;         // Device category enum
    uint16_t flags;            // Flags (bit0: tuya, bit1: battery, bit2: multiep, etc.)
    uint8_t fz_count;          // Number of fromZigbee IR rules
    uint8_t tz_count;          // Number of toZigbee IR rules
    uint8_t dp_count;          // Number of Tuya DP rules
    uint8_t ep_count;          // Number of endpoints
    uint64_t extra;            // Reserved / manufacturerCode
};

// Device Record Header (20 bytes)
struct RecordHeader {
    uint32_t model_str_offset;
    uint32_t vendor_str_offset;
    uint32_t desc_str_offset;
    uint8_t category;
    uint8_t flags;
    uint8_t fz_count;
    uint8_t tz_count;
    uint8_t dp_count;
    uint8_t ep_count;
    uint8_t bind_count;
    uint8_t reporting_count;
};

// Endpoint Descriptor (4 bytes)
struct EndpointDesc {
    uint8_t ep_id;
    uint8_t pad8;
    uint16_t name_str_offset;
};

// fromZigbee IR Rule (20 bytes)
struct FromZigbeeIR {
    uint8_t op;                // Opcode: READ_ATTR, REPORT_ATTR, TRANSFORM, MAP_ENUM
    uint8_t datatype;          // Datatype enum
    uint16_t cluster_id;       // Cluster ID (e.g. 0x0402)
    uint16_t attr_id;          // Attribute ID (e.g. 0x0000)
    uint8_t endpoint_id;       // 0 = dynamic / default, >0 = explicit
    uint8_t pad8;
    uint32_t target_str_offset;// Property name string offset
    float scale;               // Multiplier
    float offset;              // Additive offset
};

// toZigbee IR Rule (16 bytes)
struct ToZigbeeIR {
    uint8_t op;                // Opcode: WRITE_ATTR, COMMAND
    uint8_t endpoint_id;       // 0 = dynamic / default
    uint16_t cluster_id;       // Cluster ID (e.g. 0x0006)
    uint16_t cmd_or_attr;      // Command ID or Attribute ID
    uint8_t cmd_on;            // On command (0x01)
    uint8_t cmd_off;           // Off command (0x00)
    uint32_t target_str_offset;// Target field name string offset
    float scale;               // Scale multiplier
};

// Tuya DP Rule (20 bytes)
struct TuyaDpIR {
    uint8_t dp_id;             // Tuya Datapoint ID
    uint8_t datatype;          // 0: value, 1: enum, 2: bool, 3: raw, 4: string
    uint16_t pad16;
    uint32_t target_str_offset;// Property name string offset
    float scale;               // Multiplier
    float offset;              // Additive offset
    uint32_t map_str_offset;   // Offset to enum map JSON string if applicable
};

// Reporting Configuration (8 bytes)
struct ReportingConfig {
    uint16_t cluster_id;
    uint16_t attr_id;
    uint16_t min_interval;
    uint16_t max_interval;
};

#pragma pack(pop)

// Opcodes
enum class Opcode : uint8_t {
    READ_ATTR = 0x01,
    WRITE_ATTR = 0x02,
    COMMAND = 0x03,
    REPORT_ATTR = 0x04,
    BIND_CLUSTER = 0x05,
    TUYA_DP = 0x06,
    TRANSFORM = 0x07,
    MAP_ENUM = 0x08,
    BITFIELD = 0x09,
    DYNAMIC_ENDPOINT = 0x0A
};

// Datatypes
enum class DataType : uint8_t {
    BOOL = 0,
    UINT8 = 1,
    INT16 = 2,
    UINT16 = 3,
    INT32 = 4,
    UINT32 = 5,
    ENUM8 = 6,
    RAW = 7,
    STRING = 8,
    SINGLE_PREC = 9,
    DOUBLE_PREC = 10,
    UINT48 = 11,
    INT24 = 12,
    BITMAP16 = 13,
    VALUE = 14
};

// Categories
enum class DeviceCategory : uint8_t {
    GENERIC = 0,
    ON_OFF_LIGHT = 1,
    DIMMABLE_LIGHT = 2,
    COLOR_LIGHT = 3,
    ON_OFF_PLUGIN_UNIT = 4,
    ON_OFF_SWITCH = 5,
    TEMP_SENSOR = 6,
    HUMIDITY_SENSOR = 7,
    CONTACT_SENSOR = 8,
    OCCUPANCY_SENSOR = 9,
    LIGHT_SENSOR = 10,
    WATER_LEAK_SENSOR = 11,
    SMOKE_SENSOR = 12,
    THERMOSTAT = 13,
    WINDOW_COVERING = 14,
    DOOR_LOCK = 15
};

// Flags
constexpr uint16_t FLAG_TUYA = 0x0001;
constexpr uint16_t FLAG_BATTERY = 0x0002;
constexpr uint16_t FLAG_MULTI_EP = 0x0004;
constexpr uint16_t FLAG_COLOR = 0x0008;
constexpr uint16_t FLAG_REPORTING = 0x0010;

// Property value
struct PropertyValue {
    enum Type { TYPE_NONE, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING };
    Type type = TYPE_NONE;
    bool bool_val = false;
    int64_t int_val = 0;
    double float_val = 0.0;
    std::string str_val;

    std::string toString() const {
        if (type == TYPE_BOOL) return bool_val ? "true" : "false";
        if (type == TYPE_INT) return std::to_string(int_val);
        if (type == TYPE_FLOAT) {
            char buf[32];
            snprintf(buf, sizeof(buf), "%.2f", float_val);
            return std::string(buf);
        }
        if (type == TYPE_STRING) return str_val;
        return "";
    }
};

// Device Interview Info
struct EndpointInfo {
    uint8_t ep_id = 1;
    std::vector<uint16_t> input_clusters;
    std::vector<uint16_t> output_clusters;
};

struct DeviceInterview {
    uint64_t ieee_addr = 0;
    uint16_t short_addr = 0;
    std::string manufacturer_name;
    std::string model_id;
    uint16_t manufacturer_code = 0;
    std::vector<EndpointInfo> endpoints;

    bool hasInputCluster(uint16_t cl) const {
        for (const auto& ep : endpoints) {
            for (uint16_t c : ep.input_clusters) if (c == cl) return true;
        }
        return false;
    }

    uint8_t findEndpointForCluster(uint16_t cl) const {
        for (const auto& ep : endpoints) {
            for (uint16_t c : ep.input_clusters) if (c == cl) return ep.ep_id;
        }
        return 0;
    }
};

// ZCL Incoming Attribute Report
struct ZclAttributeReport {
    uint8_t endpoint = 1;
    uint16_t cluster_id = 0;
    uint16_t attribute_id = 0;
    uint8_t datatype = 0;
    const uint8_t* raw_data = nullptr;
    size_t raw_len = 0;
};

// Tuya DP Incoming Frame
struct TuyaDpMessage {
    uint8_t dp_id = 0;
    uint8_t dp_type = 0; // 0: raw, 1: bool, 2: value (4B), 3: string, 4: enum (1B), 5: bitmap
    uint32_t value = 0;
    std::string str_value;
    std::vector<uint8_t> raw_bytes;
};

// Outgoing Zigbee Command
struct ZigbeeCommand {
    uint8_t endpoint = 1;
    uint16_t cluster_id = 0;
    uint8_t command_id = 0;
    bool is_write_attr = false;
    uint16_t attribute_id = 0;
    std::vector<uint8_t> payload;
};

// Fast FNV1a-32 hash
inline uint32_t hash_fnv1a(const std::string& str) {
    uint32_t h = 0x811C9DC5;
    for (char c : str) {
        // Lowercase
        if (c >= 'A' && c <= 'Z') c += ('a' - 'A');
        h ^= static_cast<uint8_t>(c);
        h = (h * 0x01000193);
    }
    return h;
}

} // namespace z2m
