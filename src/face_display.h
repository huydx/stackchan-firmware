#pragma once
#include <stdint.h>

// Animated face on its own task (core 0), so drawing never delays audio on
// the loop task. Only this task touches the display after begin.
struct FaceView {
    char status[40] = "";
    char expression[12] = "neutral";
    float mouth = 0;     // speech level 0..1
    bool speaking = false, ready = false, muted = false;
    bool looking = false;  // a face is being tracked
    float lookX = 0, lookY = 0;  // -1..1 from center, screen coordinates
};

bool faceDisplayBegin();
// Publish the latest state from the loop task; cheap, copies under a lock.
void faceDisplayUpdate(const FaceView &view);
