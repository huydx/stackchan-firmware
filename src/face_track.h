#pragma once
#include <stdint.h>

// Turning the head toward a detected face. Angles are tenths of a degree
// (StackChan-BSP units). Face positions are normalized to -1..1 from the
// image center: x grows to the right of the image, y grows downward.
static constexpr uint8_t YAW_SERVO_ID = 1;
static constexpr int YAW_DEFAULT_ZERO = 460;
static constexpr int TRACK_YAW_LIMIT = 700, TRACK_PITCH_LIMIT = 450;
// GC0308 field of view, measured on this robot by moving the head and
// tracking a face across the image (16 degrees of yaw moved it ~100 of 320
// pixels; 10 degrees of pitch ~60 of 240), in tenths of a degree.
static constexpr int CAMERA_HFOV = 510, CAMERA_VFOV = 400;

struct Gaze {
    int yaw = 0, pitch = 0;
};

static inline int clampInt(int value, int low, int high) { return value < low ? low : value > high ? high : value; }

static inline int yawRaw(int zero, int tenths) {
    return clampInt(zero + clampInt(tenths, -TRACK_YAW_LIMIT, TRACK_YAW_LIMIT) * 16 / 50, 0, 1000);
}

// Slow, steady motion: at most maxStep per control tick.
static inline int approach(int current, int target, int maxStep) {
    return current + clampInt(target - current, -maxStep, maxStep);
}

// Each detection moves the target part of the way toward the face, ignoring
// small offsets so the head settles instead of hunting. Pass the gaze the
// snapshot was taken at: results arrive ~0.4 s later, and correcting from the
// current gaze instead would overshoot.
static inline Gaze gazeToward(Gaze target, float x, float y, bool reverseX, bool reverseY) {
    constexpr float GAIN = 0.6f, DEAD_ZONE = 0.1f;
    // Positive yaw turns the head to its left, which is the image's left
    // (measured, and "Turn Left" in StackChan-BSP), so a face on the right
    // of the image needs negative yaw.
    if (x > DEAD_ZONE || x < -DEAD_ZONE) target.yaw -= int((reverseX ? -x : x) * CAMERA_HFOV / 2 * GAIN);
    if (y > DEAD_ZONE || y < -DEAD_ZONE) target.pitch -= int((reverseY ? -y : y) * CAMERA_VFOV / 2 * GAIN);
    target.yaw = clampInt(target.yaw, -TRACK_YAW_LIMIT, TRACK_YAW_LIMIT);
    target.pitch = clampInt(target.pitch, 0, TRACK_PITCH_LIMIT);
    return target;
}

// Searching for a face: a slow yaw sweep that switches between a low and a
// high pitch row at each end, so the camera covers from level to well above.
static constexpr int SEARCH_YAW = 500, SEARCH_LOW = 100, SEARCH_HIGH = 250, SEARCH_STEP = 6;
struct Search {
    int direction = 1;
    bool high = false;
};

static inline Gaze searchStep(Gaze gaze, Search &search) {
    gaze.pitch = approach(gaze.pitch, search.high ? SEARCH_HIGH : SEARCH_LOW, SEARCH_STEP);
    gaze.yaw += search.direction * SEARCH_STEP;
    if (gaze.yaw >= SEARCH_YAW || gaze.yaw <= -SEARCH_YAW) {
        gaze.yaw = clampInt(gaze.yaw, -SEARCH_YAW, SEARCH_YAW);
        search.direction = -search.direction;
        search.high = !search.high;
    }
    return gaze;
}

// Normalized center of a face box in an image of the given size.
static inline void faceCenter(int left, int top, int right, int bottom, int width, int height, float &x, float &y) {
    x = (left + right) / float(width) - 1.0f;
    y = (top + bottom) / float(height) - 1.0f;
}
