#include "converter_runtime.h"
#include "converter_debug.h"
#include <cassert>
#include <iostream>

using namespace z2m;

void test_bundle_loading(ConverterRuntime& runtime, const std::string& bundle_path) {
    std::cout << "\n[TEST 1] Loading Binary Bundle v3: " << bundle_path << std::endl;
    auto reader = std::make_shared<FileBundleReader>(bundle_path);
    assert(reader->isOpen() && "Failed to open bundle file!");
    assert(runtime.init(reader) && "Failed to initialize runtime with bundle!");

    const auto& hdr = runtime.bundle().header();
    assert(std::memcmp(hdr.magic, "Z2MB", 4) == 0 && "Invalid magic!");
    assert(hdr.version == 3 && "Invalid format version!");
    assert(hdr.ir_version == 3 && "Invalid IR version!");
    assert(hdr.device_count > 4000 && "Device count too low!");
    assert(hdr.model_idx_count > 6000 && "Model index count too low!");
    assert(hdr.fp_idx_count > 1500 && "Fingerprint index count too low!");

    std::cout << "✓ Bundle Header verified: "
              << hdr.device_count << " devices, "
              << hdr.model_idx_count << " models, "
              << hdr.fp_idx_count << " fingerprints, "
              << hdr.total_size << " bytes." << std::endl;
}

void test_binary_search(const ConverterBundle& bundle) {
    std::cout << "\n[TEST 2] Testing Binary Search Speed and Accuracy..." << std::endl;
    ConverterMatcher matcher(bundle);

    std::vector<std::string> test_models = {
        "TS0201", "SNZB-02P", "ZBMINI", "ZWSH16"
    };

    for (const auto& model : test_models) {
        IndexEntry entry;
        uint32_t seeks = 0;
        bool found = matcher.findByModel(model, entry, &seeks);
        assert(found && "Model must be found in index!");
        assert(seeks <= 15 && "Binary search must complete in <= 15 seeks!");

        MatchedConverter conv;
        assert(matcher.loadRecordDetails(entry, conv) && "Must load record details!");
        std::cout << "  ✓ Found Model: [" << model << "] in " << seeks << " seeks -> "
                  << conv.model << " (" << conv.vendor << "), Category=" << static_cast<int>(conv.category)
                  << ", FZ rules=" << conv.fz_rules.size()
                  << ", Tuya DPs=" << conv.tuya_dps.size() << std::endl;
    }

    // Test fingerprint search
    std::string test_mfg = "_TYZB01_ujfk3xd9";
    std::string test_fp_model = "TS0201";
    IndexEntry fp_entry;
    uint32_t fp_seeks = 0;
    bool fp_found = matcher.findByFingerprint(test_mfg, test_fp_model, fp_entry, &fp_seeks);
    assert(fp_found && "Fingerprint must be found in index!");
    std::cout << "  ✓ Found Fingerprint: [" << test_mfg << "|" << test_fp_model << "] in " << fp_seeks << " seeks." << std::endl;
}

void test_zcl_decoding(ConverterRuntime& runtime) {
    std::cout << "\n[TEST 3] Testing ZCL Decoding & State Updating..." << std::endl;

    DeviceInterview sonoff_sensor;
    sonoff_sensor.ieee_addr = 0x00124B0018E12345ULL;
    sonoff_sensor.short_addr = 0x1234;
    sonoff_sensor.model_id = "SNZB-02P";
    sonoff_sensor.manufacturer_name = "SONOFF";
    EndpointInfo ep1;
    ep1.ep_id = 1;
    ep1.input_clusters = {0x0000, 0x0001, 0x0402, 0x0405};
    sonoff_sensor.endpoints.push_back(ep1);

    assert(runtime.handleDeviceInterview(sonoff_sensor) && "Interview must match!");

    bool callback_fired = false;
    runtime.onStateChange([&](uint64_t ieee, const std::string& prop, const PropertyValue& val, const std::string& payload) {
        callback_fired = true;
        std::cout << "  ✓ State Callback fired: IEEE=" << std::hex << ieee << std::dec
                  << " Prop=" << prop << " Value=" << val.toString()
                  << " Payload=" << payload << std::endl;
    });

    // Simulate Temperature report: Cluster 0x0402, Attr 0x0000, int16 = 2350 (23.50 °C)
    uint8_t raw_temp[2] = {static_cast<uint8_t>(2350 & 0xFF), static_cast<uint8_t>((2350 >> 8) & 0xFF)};
    ZclAttributeReport temp_report;
    temp_report.endpoint = 1;
    temp_report.cluster_id = 0x0402;
    temp_report.attribute_id = 0x0000;
    temp_report.datatype = static_cast<uint8_t>(DataType::INT16);
    temp_report.raw_data = raw_temp;
    temp_report.raw_len = 2;

    assert(runtime.handleZclReport(sonoff_sensor.ieee_addr, temp_report) && "ZCL report must be decoded!");
    assert(callback_fired && "Callback must have fired!");

    PropertyValue pv;
    assert(runtime.stateCache().getProperty(sonoff_sensor.ieee_addr, "temperature", pv));
    assert(pv.float_val > 23.49 && pv.float_val < 23.51);

    // Simulate Humidity report: Cluster 0x0405, Attr 0x0000, uint16 = 5820 (58.20 %)
    uint8_t raw_hum[2] = {static_cast<uint8_t>(5820 & 0xFF), static_cast<uint8_t>((5820 >> 8) & 0xFF)};
    ZclAttributeReport hum_report;
    hum_report.endpoint = 1;
    hum_report.cluster_id = 0x0405;
    hum_report.attribute_id = 0x0000;
    hum_report.datatype = static_cast<uint8_t>(DataType::UINT16);
    hum_report.raw_data = raw_hum;
    hum_report.raw_len = 2;

    assert(runtime.handleZclReport(sonoff_sensor.ieee_addr, hum_report));
    std::string json_state = runtime.stateCache().buildJsonPayload(sonoff_sensor.ieee_addr);
    std::cout << "  ✓ Combined State JSON: " << json_state << std::endl;
    assert(json_state.find("\"temperature\":23.50") != std::string::npos);
    assert(json_state.find("\"humidity\":58.20") != std::string::npos);
    runtime.onStateChange(nullptr);
}

void test_tuya_dp_decoding(ConverterRuntime& runtime) {
    std::cout << "\n[TEST 4] Testing Tuya DP Profile Decoding..." << std::endl;

    DeviceInterview tuya_dev;
    tuya_dev.ieee_addr = 0xA4C1380001020304ULL;
    tuya_dev.short_addr = 0x5678;
    tuya_dev.model_id = "ZWSH16";
    tuya_dev.manufacturer_name = "AVATTO";
    EndpointInfo ep1;
    ep1.ep_id = 1;
    ep1.input_clusters = {0x0000, 0xEF00};
    tuya_dev.endpoints.push_back(ep1);

    assert(runtime.handleDeviceInterview(tuya_dev) && "Tuya interview must match!");

    // Construct raw Tuya frame: seq=1, dp=1 (temperature), type=2 (value 4B BE), len=4, value=255 (25.5 °C)
    uint8_t tuya_frame[10] = {
        0x00, 0x01,       // seq
        0x01,             // dp=1
        0x02,             // type=value
        0x00, 0x04,       // len=4
        0x00, 0x00, 0x00, 0xFF // 255
    };

    assert(runtime.handleTuyaFrame(tuya_dev.ieee_addr, tuya_frame, sizeof(tuya_frame)));

    PropertyValue pv;
    assert(runtime.stateCache().getProperty(tuya_dev.ieee_addr, "temperature", pv));
    std::cout << "  ✓ Decoded Tuya DP 1 (temperature): " << pv.float_val << " °C" << std::endl;
    assert(pv.float_val > 25.49 && pv.float_val < 25.51);

    // Test Tuya enum DP 9 (temperature_unit = 0 -> "celsius")
    uint8_t tuya_enum_frame[7] = {
        0x00, 0x02, // seq
        0x09,       // dp=9
        0x04,       // type=enum
        0x00, 0x01, // len=1
        0x00        // value=0 ("celsius")
    };
    assert(runtime.handleTuyaFrame(tuya_dev.ieee_addr, tuya_enum_frame, sizeof(tuya_enum_frame)));
    assert(runtime.stateCache().getProperty(tuya_dev.ieee_addr, "temperature_unit", pv));
    std::cout << "  ✓ Decoded Tuya DP 9 (temperature_unit): " << pv.str_val << std::endl;
    assert(pv.str_val == "celsius");
    runtime.onStateChange(nullptr);
}

void test_downlink_commands(ConverterRuntime& runtime) {
    std::cout << "\n[TEST 5] Testing Downlink Control Command Synthesis..." << std::endl;

    DeviceInterview zbmini;
    zbmini.ieee_addr = 0x00124B0019998877ULL;
    zbmini.short_addr = 0x8899;
    zbmini.model_id = "ZBMINI";
    zbmini.manufacturer_name = "SONOFF";
    EndpointInfo ep1;
    ep1.ep_id = 1;
    ep1.input_clusters = {0x0000, 0x0006};
    zbmini.endpoints.push_back(ep1);

    assert(runtime.handleDeviceInterview(zbmini));

    bool tx_called = false;
    ZigbeeCommand last_cmd;
    runtime.onZigbeeTx([&](uint64_t ieee, uint16_t /*s_addr*/, const ZigbeeCommand& cmd) {
        tx_called = true;
        last_cmd = cmd;
        std::cout << "  ✓ Zigbee TX dispatched: IEEE=" << std::hex << ieee << std::dec
                  << " Cluster=0x" << std::hex << cmd.cluster_id << " Cmd=0x" << (int)cmd.command_id
                  << std::dec << " Ep=" << (int)cmd.endpoint << std::endl;
        return true;
    });

    PropertyValue val_on;
    val_on.type = PropertyValue::TYPE_BOOL;
    val_on.bool_val = true;

    assert(runtime.setDeviceProperty(zbmini.ieee_addr, "state", val_on) && "Must build control command!");
    assert(tx_called && "TX callback must be invoked!");
    assert(last_cmd.cluster_id == 0x0006);
    assert(last_cmd.command_id == 0x01); // On command
    runtime.onZigbeeTx(nullptr);
}

int main(int argc, char** argv) {
    std::string bundle_path = "dist/z2m_bundle.bin";
    if (argc > 1) bundle_path = argv[1];

    std::cout << "============================================================" << std::endl;
    std::cout << "  Z2M ESP32 Converter Runtime v3.0 Native Test Suite       " << std::endl;
    std::cout << "============================================================" << std::endl;

    ConverterRuntime runtime;
    test_bundle_loading(runtime, bundle_path);
    test_binary_search(runtime.bundle());
    test_zcl_decoding(runtime);
    test_tuya_dp_decoding(runtime);
    test_downlink_commands(runtime);

    std::cout << "\n============================================================" << std::endl;
    std::cout << "  🎉 ALL TESTS PASSED SUCCESSFULLY! (v3.0 Architecture OK) " << std::endl;
    std::cout << "============================================================" << std::endl;

    return 0;
}
