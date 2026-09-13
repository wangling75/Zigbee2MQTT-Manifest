#pragma once

#include "converter_types.h"
#include <memory>
#include <cstdio>

namespace z2m {

class IBundleReader {
public:
    virtual ~IBundleReader() = default;
    virtual bool read(size_t offset, void* dest, size_t size) = 0;
    virtual size_t size() const = 0;
    virtual const uint8_t* directPointer(size_t /*offset*/, size_t /*size*/) const { return nullptr; }
};

// Zero-copy in-memory or flash memory-mapped bundle reader
class MemoryBundleReader : public IBundleReader {
public:
    MemoryBundleReader(const uint8_t* data, size_t size) : data_(data), size_(size) {}

    bool read(size_t offset, void* dest, size_t size) override {
        if (!data_ || offset + size > size_) return false;
        std::memcpy(dest, data_ + offset, size);
        return true;
    }

    size_t size() const override { return size_; }
    const uint8_t* directPointer(size_t offset, size_t size) const override {
        if (!data_ || offset + size > size_) return nullptr;
        return data_ + offset;
    }

private:
    const uint8_t* data_;
    size_t size_;
};

// File-based bundle reader (for host unit tests / LittleFS / SPIFFS)
class FileBundleReader : public IBundleReader {
public:
    explicit FileBundleReader(const std::string& path);
    ~FileBundleReader() override;

    bool isOpen() const { return file_ != nullptr; }
    bool read(size_t offset, void* dest, size_t size) override;
    size_t size() const override { return size_; }

private:
    FILE* file_ = nullptr;
    size_t size_ = 0;
};

class ConverterBundle {
public:
    ConverterBundle() = default;
    ~ConverterBundle() = default;

    bool load(std::shared_ptr<IBundleReader> reader);
    bool isValid() const { return valid_; }

    const BundleHeader& header() const { return header_; }
    std::string getString(uint32_t offset) const;

    bool readModelIndexEntry(uint32_t index, IndexEntry& entry) const;
    bool readFpIndexEntry(uint32_t index, IndexEntry& entry) const;
    bool readRecordHeader(uint32_t record_offset, RecordHeader& header) const;

    std::shared_ptr<IBundleReader> reader() const { return reader_; }

private:
    std::shared_ptr<IBundleReader> reader_;
    BundleHeader header_;
    bool valid_ = false;
};

} // namespace z2m
