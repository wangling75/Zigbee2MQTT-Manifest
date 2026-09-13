#include "converter_bundle.h"
#include <iostream>

namespace z2m {

FileBundleReader::FileBundleReader(const std::string& path) {
    file_ = std::fopen(path.c_str(), "rb");
    if (file_) {
        std::fseek(file_, 0, SEEK_END);
        size_ = std::ftell(file_);
        std::fseek(file_, 0, SEEK_SET);
    }
}

FileBundleReader::~FileBundleReader() {
    if (file_) {
        std::fclose(file_);
        file_ = nullptr;
    }
}

bool FileBundleReader::read(size_t offset, void* dest, size_t size) {
    if (!file_ || offset + size > size_) return false;
    if (std::fseek(file_, static_cast<long>(offset), SEEK_SET) != 0) return false;
    return std::fread(dest, 1, size, file_) == size;
}

bool ConverterBundle::load(std::shared_ptr<IBundleReader> reader) {
    valid_ = false;
    reader_ = reader;
    if (!reader_ || reader_->size() < HEADER_SIZE) {
        return false;
    }

    if (!reader_->read(0, &header_, sizeof(header_))) {
        return false;
    }

    // Verify magic
    if (std::memcmp(header_.magic, "Z2MB", 4) != 0) {
        return false;
    }

    // Verify version
    if (header_.version != FORMAT_VERSION || header_.ir_version != IR_VERSION) {
        return false;
    }

    // Verify boundary constraints
    if (header_.total_size > reader_->size()) {
        return false;
    }

    valid_ = true;
    return true;
}

std::string ConverterBundle::getString(uint32_t offset) const {
    if (!valid_ || !reader_ || offset == 0) return "";
    size_t abs_off = header_.strings_offset + offset;
    if (abs_off >= reader_->size()) return "";

    // Fast path if direct pointer available
    const uint8_t* ptr = reader_->directPointer(abs_off, 256);
    if (ptr) {
        return std::string(reinterpret_cast<const char*>(ptr));
    }

    // Read byte by byte or in small chunks
    std::string result;
    char ch = 0;
    while (abs_off < reader_->size()) {
        if (!reader_->read(abs_off++, &ch, 1) || ch == 0) break;
        result.push_back(ch);
        if (result.size() > 512) break; // Limit safety
    }
    return result;
}

bool ConverterBundle::readModelIndexEntry(uint32_t index, IndexEntry& entry) const {
    if (!valid_ || !reader_ || index >= header_.model_idx_count) return false;
    size_t off = header_.model_idx_offset + index * INDEX_ENTRY_SIZE;
    return reader_->read(off, &entry, sizeof(entry));
}

bool ConverterBundle::readFpIndexEntry(uint32_t index, IndexEntry& entry) const {
    if (!valid_ || !reader_ || index >= header_.fp_idx_count) return false;
    size_t off = header_.fp_idx_offset + index * INDEX_ENTRY_SIZE;
    return reader_->read(off, &entry, sizeof(entry));
}

bool ConverterBundle::readRecordHeader(uint32_t record_offset, RecordHeader& header) const {
    if (!valid_ || !reader_) return false;
    size_t abs_off = header_.records_offset + record_offset;
    return reader_->read(abs_off, &header, sizeof(header));
}

} // namespace z2m
