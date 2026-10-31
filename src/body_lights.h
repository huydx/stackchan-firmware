#pragma once
#include <stdint.h>

// Colors for the StackChan body's 12 RGB LEDs, as RGB565. Hardware access
// lives in main.cpp; this stays host-testable.
// Matches muse-gadget-sdk's esp32/components/muse/muse_stackchan_light.c
// (brightness 48 / 255).
enum class BodyEffect : uint8_t { Off, Muted, Speaking };

static constexpr uint16_t BODY_RED = (48 >> 3) << 11;

static inline uint16_t rgb565(unsigned r, unsigned g, unsigned b) {
    return uint16_t(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
}

// A gentle six-second hue cycle, limited to RGB888 brightness 48.
static inline uint16_t bodyRainbow(uint32_t nowMs) {
    const unsigned phase = (nowMs / 100) % 60;
    const unsigned up = (phase % 10) * 48 / 10, down = 48 - up;
    switch (phase / 10) {
    case 0: return rgb565(48, up, 0);
    case 1: return rgb565(down, 48, 0);
    case 2: return rgb565(0, 48, up);
    case 3: return rgb565(0, down, 48);
    case 4: return rgb565(up, 0, 48);
    default: return rgb565(48, 0, down);
    }
}

static inline uint16_t bodyColor(BodyEffect effect, uint32_t nowMs) {
    return effect == BodyEffect::Speaking ? bodyRainbow(nowMs) : effect == BodyEffect::Muted ? BODY_RED : 0;
}
