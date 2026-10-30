#pragma once
#include <math.h>
#include <stddef.h>
#include <stdint.h>

// Head nodding on the StackChan pitch servo (Feetech SCS, ID 2), following
// m5stack/StackChan-BSP: one raw step is 0.3125 degree, angles are in tenths
// of a degree, 0 is the calibrated level rest position and 900 looks up.
static constexpr uint8_t PITCH_SERVO_ID = 2;
static constexpr int PITCH_DEFAULT_ZERO = 620, PITCH_MAX_TENTHS = 900, SERVO_RAW_MAX = 1000;

static inline int pitchRaw(int zero, int tenths) {
    if (tenths < 0) tenths = 0;
    if (tenths > PITCH_MAX_TENTHS) tenths = PITCH_MAX_TENTHS;
    const int raw = zero + tenths * 16 / 50;
    return raw < 0 ? 0 : raw > SERVO_RAW_MAX ? SERVO_RAW_MAX : raw;
}

// A smooth nod: up to amplitude and back to rest once per period.
static inline int nodTenths(uint32_t elapsedMs, int amplitudeTenths, uint32_t periodMs) {
    if (!periodMs || amplitudeTenths <= 0) return 0;
    const float phase = float(elapsedMs % periodMs) / float(periodMs);
    return int(lroundf(amplitudeTenths * 0.5f * (1.0f - cosf(phase * 6.2831853f))));
}

// SCS write packet: FF FF id len instruction address data... checksum.
// SCSCL servos are big-endian. Returns the packet length.
static inline size_t scsWrite(uint8_t *out, uint8_t id, uint8_t address, const uint8_t *data, uint8_t length) {
    out[0] = out[1] = 0xff;
    out[2] = id;
    out[3] = length + 3;
    out[4] = 0x03;  // INST_WRITE
    out[5] = address;
    uint8_t sum = id + out[3] + out[4] + address;
    for (uint8_t i = 0; i < length; ++i) sum += out[6 + i] = data[i];
    out[6 + length] = ~sum;
    return 7 + length;
}

static inline size_t scsGoalPosition(uint8_t *out, uint8_t id, int raw, uint16_t timeMs) {
    const uint8_t data[6] = {uint8_t(raw >> 8), uint8_t(raw), uint8_t(timeMs >> 8), uint8_t(timeMs), 0, 0};
    return scsWrite(out, id, 42, data, sizeof data);  // GOAL_POSITION, GOAL_TIME, GOAL_SPEED
}

static inline size_t scsTorque(uint8_t *out, uint8_t id, bool enabled) {
    const uint8_t data[1] = {uint8_t(enabled)};
    return scsWrite(out, id, 40, data, sizeof data);  // TORQUE_ENABLE
}
