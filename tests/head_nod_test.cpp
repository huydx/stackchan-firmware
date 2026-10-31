#include "head_nod.h"
#include <cassert>
#include <cstring>

int main() {
    // Steps of 0.3125 degree from the calibrated zero, clamped to the servo range.
    assert(pitchRaw(PITCH_DEFAULT_ZERO, 0) == 620);
    assert(pitchRaw(PITCH_DEFAULT_ZERO, 100) == 652);
    assert(pitchRaw(PITCH_DEFAULT_ZERO, -50) == 620);
    assert(pitchRaw(PITCH_DEFAULT_ZERO, 5000) == 620 + 900 * 16 / 50);
    assert(pitchRaw(900, 900) == SERVO_RAW_MAX);

    // Starts and ends each nod at rest, peaks halfway, never leaves the range.
    assert(nodTenths(0, 60, 2000) == 0);
    assert(nodTenths(1000, 60, 2000) == 60);
    assert(nodTenths(2000, 60, 2000) == 0);
    assert(nodTenths(500, 60, 2000) == 30);
    for (uint32_t t = 0; t < 6000; t += 37) {
        const int value = nodTenths(t, 60, 2000);
        assert(value >= 0 && value <= 60);
    }
    assert(nodTenths(1000, 0, 2000) == 0 && nodTenths(1000, 60, 0) == 0);

    // Known-good packets, as SCSCL::WritePos(2, 652, 50, 0) and EnableTorque(2, 0) send them.
    uint8_t packet[16];
    const uint8_t goal[] = {0xff, 0xff, 0x02, 0x09, 0x03, 0x2a, 0x02, 0x8c, 0x00, 0x32, 0x00, 0x00, 0x07};
    assert(scsGoalPosition(packet, 2, 652, 50) == sizeof goal && !memcmp(packet, goal, sizeof goal));
    const uint8_t torque[] = {0xff, 0xff, 0x02, 0x04, 0x03, 0x28, 0x00, 0xce};
    assert(scsTorque(packet, 2, false) == sizeof torque && !memcmp(packet, torque, sizeof torque));

    // Position read request, and parsing a reply after an echoed request.
    const uint8_t read[] = {0xff, 0xff, 0x02, 0x04, 0x02, 0x38, 0x02, 0xbd};
    assert(scsReadPosition(packet, 2) == sizeof read && !memcmp(packet, read, sizeof read));
    const uint8_t bus[] = {0xff, 0xff, 0x02, 0x04, 0x02, 0x38, 0x02, 0xbd,   // echo
                           0xff, 0xff, 0x02, 0x04, 0x00, 0x02, 0x6c, 0x8b};  // reply: 620
    assert(scsParsePosition(bus, sizeof bus, 2) == 620);
    assert(scsParsePosition(bus, 8, 2) == -1);
    assert(scsParsePosition(bus, sizeof bus, 1) == -1);
}
