#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>

// The producer owns all fields except released, which the speaker task sets.
// Memory remains borrowed until that exact pointer is explicitly released.
class PlaybackPool {
public:
    static constexpr size_t BLOCK_BYTES = 4096, SLOTS = 3, FRAMES = 4;
    struct Block {
        int16_t pcm[BLOCK_BYTES / 2];
        uint16_t frameBytes[FRAMES];
        size_t bytes = 0, frames = 0;
        bool queued = false;
        std::atomic<bool> released{false};
    };

    Block *freeBlock() {
        for (auto &block : blocks) if (!block.queued) return &block;
        return nullptr;
    }
    bool submit(Block *block) {
        if (!block || block->queued || count == SLOTS) return false;
        block->released.store(false, std::memory_order_relaxed);
        block->queued = true;
        order[write] = block;
        write = (write + 1) % SLOTS;
        ++count;
        return true;
    }
    void release(const void *data) {
        for (auto &block : blocks) if (data == block.pcm) {
            block.released.store(true, std::memory_order_release);
            return;
        }
    }
    Block *releasedFront() {
        return count && order[read]->released.load(std::memory_order_acquire) ? order[read] : nullptr;
    }
    void popReleased() {
        Block *block = releasedFront();
        if (!block) return;
        block->queued = false;
        block->bytes = block->frames = 0;
        read = (read + 1) % SLOTS;
        --count;
    }
    size_t pending() const { return count; }
    // Only after Speaker.end() joins the task, so no callbacks remain in flight.
    void reset() {
        for (auto &block : blocks) {
            block.queued = false;
            block.bytes = block.frames = 0;
            block.released.store(false, std::memory_order_relaxed);
        }
        read = write = count = 0;
    }
private:
    Block blocks[SLOTS];
    Block *order[SLOTS];
    size_t read = 0, write = 0, count = 0;
};
