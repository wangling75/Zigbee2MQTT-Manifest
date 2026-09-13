#pragma once

#include "converter_types.h"
#include "converter_bundle.h"
#include "converter_matcher.h"

namespace z2m {

class ConverterTuya {
public:
    explicit ConverterTuya(const ConverterBundle& bundle);

    // Parse Tuya raw payload (Cluster 0xEF00 commands 0x01/0x02/0x06) into TuyaDpMessage
    static bool parseTuyaRawFrame(const uint8_t* payload, size_t len, TuyaDpMessage& out_msg);

    // Decode TuyaDpMessage using the matched converter's Tuya DP rules
    bool decodeTuyaDp(const MatchedConverter& converter,
                      const TuyaDpMessage& msg,
                      std::string& out_property,
                      PropertyValue& out_value);

    // Build outgoing Tuya DP write frame (Cluster 0xEF00 Command 0x00 or 0x04)
    bool buildTuyaWriteCommand(const MatchedConverter& converter,
                               const std::string& property,
                               const PropertyValue& target_value,
                               uint8_t endpoint,
                               uint16_t seq,
                               ZigbeeCommand& out_cmd);

private:
    const ConverterBundle& bundle_;
};

} // namespace z2m
