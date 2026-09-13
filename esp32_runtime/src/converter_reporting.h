#pragma once

#include "converter_types.h"
#include "converter_matcher.h"

namespace z2m {

struct BindRequest {
    uint8_t endpoint = 1;
    uint16_t cluster_id = 0;
};

class ConverterReporting {
public:
    // Generate list of clusters that must be bound to the coordinator
    static std::vector<BindRequest> getRequiredBinds(const DeviceInterview& interview,
                                                     const MatchedConverter& converter);

    // Generate list of ZCL attribute reporting configurations
    static std::vector<ReportingConfig> getReportingConfigs(const MatchedConverter& converter);
};

} // namespace z2m
