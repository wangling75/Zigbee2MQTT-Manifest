#pragma once

#include "converter_types.h"
#include "converter_bundle.h"
#include "converter_matcher.h"

namespace z2m {

class ConverterZcl {
public:
    explicit ConverterZcl(const ConverterBundle& bundle);

    // Decode incoming ZCL attribute report using converter's fromZigbee IR rules
    bool decodeAttributeReport(const MatchedConverter& converter,
                               const ZclAttributeReport& report,
                               std::string& out_property,
                               PropertyValue& out_value);

    // Build outgoing ZCL command from target property control request
    bool buildCommand(const MatchedConverter& converter,
                      const std::string& property,
                      const PropertyValue& target_value,
                      uint8_t target_endpoint,
                      ZigbeeCommand& out_cmd);

private:
    const ConverterBundle& bundle_;
};

} // namespace z2m
