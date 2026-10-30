#pragma once
#include <stdint.h>

// Turning the head toward a detected face. Angles are tenths of a degree
// (StackChan-BSP units). Face positions are normalized to -1..1 from the
// image center: x grows to the right of the image, y grows downward.
static constexpr uint8_t YAW_SERVO_ID = 1;
static constexpr int YAW_DEFAULT_ZERO = 460;
static constexpr int TRACK_YAW_LIMIT = 700, TRACK_PITCH_LIMIT = 350;
// GC0308 lens field of view, approximately, in tenths of a degree.
static constexpr int CAMERA_HFOV = 620, CAMERA_VFOV = 480;

struct Gaze {
    int yaw = 0, pitch = 0;
};

static inline int clampInt(int value, int low, int high) { return value < low ? low : value > high ? high : value; }

static inline int yawRaw(int zero, int tenths) {
    return clampInt(zero + clampInt(tenths, -TRACK_YAW_LIMIT, TRACK_YAW_LIMIT) * 16 / 50, 0, 1000);
}

// Each detection moves the target part of the way toward the face, ignoring
// small offsets so the head settles instead of hunting.
static inline Gaze gazeToward(Gaze target, float x, float y, bool reverseX, bool reverseY) {
    constexpr float GAIN = 0.6f, DEAD_ZONE = 0.1f;
    if (x > DEAD_ZONE || x < -DEAD_ZONE) target.yaw += int((reverseX ? -x : x) * CAMERA_HFOV / 2 * GAIN);
    if (y > DEAD_ZONE || y < -DEAD_ZONE) target.pitch -= int((reverseY ? -y : y) * CAMERA_VFOV / 2 * GAIN);
    target.yaw = clampInt(target.yaw, -TRACK_YAW_LIMIT, TRACK_YAW_LIMIT);
    target.pitch = clampInt(target.pitch, 0, TRACK_PITCH_LIMIT);
    return target;
}

// Slow, steady motion: at most maxStep per control tick.
static inline int approach(int current, int target, int maxStep) {
    return current + clampInt(target - current, -maxStep, maxStep);
}

// Normalized center of a face box in an image of the given size.
static inline void faceCenter(int left, int top, int right, int bottom, int width, int height, float &x, float &y) {
    x = (left + right) / float(width) - 1.0f;
    y = (top + bottom) / float(height) - 1.0f;
}
