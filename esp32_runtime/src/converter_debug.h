#pragma once

#include "converter_types.h"
#include <cstdio>
#include <string>

namespace z2m {

class ConverterDebug {
public:
    enum Level { DEBUG, INFO, WARN, ERROR };

    static void setLevel(Level level);
    static void log(Level level, const char* tag, const char* fmt, ...);
    static void reportUnsupported(const std::string& model, const std::string& reason);
};

} // namespace z2m
