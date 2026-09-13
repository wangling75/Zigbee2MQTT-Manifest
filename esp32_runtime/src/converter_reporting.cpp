#include "converter_reporting.h"
#include "converter_endpoint.h"

namespace z2m {

std::vector<BindRequest> ConverterReporting::getRequiredBinds(const DeviceInterview& interview,
                                                             const MatchedConverter& converter) {
    std::vector<BindRequest> binds;
    for (uint16_t cl : converter.binds) {
        uint8_t ep = EndpointResolver::resolve(interview, converter, cl, 0);
        binds.push_back({ep, cl});
    }
    return binds;
}

std::vector<ReportingConfig> ConverterReporting::getReportingConfigs(const MatchedConverter& converter) {
    return converter.reporting_configs;
}

} // namespace z2m
