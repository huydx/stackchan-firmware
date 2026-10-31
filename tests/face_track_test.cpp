#include "face_track.h"
#include <cassert>

int main() {
    float x, y;
    faceCenter(140, 100, 180, 140, 320, 240, x, y);
    assert(x == 0.0f && y == 0.0f);
    faceCenter(0, 0, 80, 60, 320, 240, x, y);
    assert(x == -0.75f && y == -0.75f);

    // Centered faces leave the gaze alone; off-center ones move part of the way.
    Gaze still = gazeToward(Gaze(), 0.05f, -0.05f, false, false);
    assert(still.yaw == 0 && still.pitch == 0);
    Gaze right = gazeToward(Gaze(), 0.5f, 0.0f, false, false);
    assert(right.yaw == -int(0.5f * CAMERA_HFOV / 2 * 0.6f) && right.pitch == 0);
    assert(gazeToward(Gaze(), 0.5f, 0.0f, true, false).yaw == -right.yaw);
    // A face above center tips the head up; pitch never goes below rest.
    Gaze up = gazeToward(Gaze(), 0.0f, -0.5f, false, false);
    assert(up.pitch > 0);
    assert(gazeToward(Gaze(), 0.0f, 0.5f, false, false).pitch == 0);
    assert(gazeToward(Gaze(), 0.0f, 0.5f, false, true).pitch > 0);

    // Limits hold no matter how far the face is.
    Gaze far;
    far.yaw = TRACK_YAW_LIMIT;
    far.pitch = TRACK_PITCH_LIMIT;
    far = gazeToward(far, -1.0f, -1.0f, false, false);
    assert(far.yaw == TRACK_YAW_LIMIT && far.pitch == TRACK_PITCH_LIMIT);

    assert(approach(0, 100, 15) == 15 && approach(100, 0, 15) == 85 && approach(10, 12, 15) == 12);
    assert(yawRaw(YAW_DEFAULT_ZERO, 0) == 460);
    assert(yawRaw(YAW_DEFAULT_ZERO, 100000) == 460 + TRACK_YAW_LIMIT * 16 / 50);
    assert(yawRaw(YAW_DEFAULT_ZERO, -100000) == 460 - TRACK_YAW_LIMIT * 16 / 50);

    // The search sweeps yaw end to end, switching pitch rows at each end.
    Search search;
    Gaze sweep;
    int ends = 0, maxPitch = 0;
    for (int i = 0; i < 2000 && ends < 3; ++i) {
        const int direction = search.direction;
        sweep = searchStep(sweep, search);
        assert(sweep.yaw >= -SEARCH_YAW && sweep.yaw <= SEARCH_YAW);
        if (search.direction != direction) ++ends;
        if (sweep.pitch > maxPitch) maxPitch = sweep.pitch;
    }
    assert(ends == 3 && maxPitch == SEARCH_HIGH);
}
