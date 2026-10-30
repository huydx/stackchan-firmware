#include "body_lights.h"
#include <cassert>

int main() {
    assert(bodyColor(BodyEffect::Off, 1234) == 0);
    assert(bodyColor(BodyEffect::Muted, 0) == 0x3000);
    assert(bodyColor(BodyEffect::Muted, 999999) == BODY_RED);
    // Starts red, passes through green and blue, and repeats every six seconds.
    assert(bodyRainbow(0) == rgb565(48, 0, 0));
    assert(bodyRainbow(2000) == rgb565(0, 48, 0));
    assert(bodyRainbow(4000) == rgb565(0, 0, 48));
    assert(bodyRainbow(6000) == bodyRainbow(0));
    for (uint32_t t = 0; t < 6000; t += 100) {
        const uint16_t color = bodyColor(BodyEffect::Speaking, t);
        assert(color != 0);
        // Never brighter than 48 per channel.
        assert((color >> 11) <= (48 >> 3) && ((color >> 5) & 0x3f) <= (48 >> 2) && (color & 0x1f) <= (48 >> 3));
    }
}
