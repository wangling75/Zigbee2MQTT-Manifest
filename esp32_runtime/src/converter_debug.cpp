#include "converter_debug.h"
#include <cstdarg>

namespace z2m {

static ConverterDebug::Level g_log_level = ConverterDebug::INFO;

void ConverterDebug::setLevel(Level level) {
    g_log_level = level;
}

void ConverterDebug::log(Level level, const char* tag, const char* fmt, ...) {
    if (level < g_log_level) return;

    const char* lvl_str = "INFO";
    if (level == DEBUG) lvl_str = "DEBUG";
    else if (level == WARN) lvl_str = "WARN";
    else if (level == ERROR) lvl_str = "ERROR";

    std::printf("[%s] [%s] ", lvl_str, tag);
    va_list args;
    va_start(args, fmt);
    std::vprintf(fmt, args);
    va_end(args);
    std::printf("\n");
}

void ConverterDebug::reportUnsupported(const std::string& model, const std::string& reason) {
    log(WARN, "ConverterRuntime", "Device %s has unsupported capability: %s", model.c_str(), reason.c_str());
}

} // namespace z2m
