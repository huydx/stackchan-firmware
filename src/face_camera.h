#pragma once
#include <stddef.h>
#include <stdint.h>

// Front camera snapshots for face tracking. Faces are detected on the relay
// (the on-device detector does not fit in this app's flash), which replies
// with the face position. Capture and JPEG encoding run on core 0.
// Start before audio: the camera borrows the internal I2C bus during init.
bool faceCameraBegin();
void faceCameraSetEnabled(bool enabled);
// Takes ownership of the newest snapshot: "FRM1" + 160x120 grayscale JPEG.
// The caller must free() it.
bool faceCameraTakeFrame(uint8_t *&message, size_t &length);
// Relay result for the last snapshot.
void faceCameraSetFace(float x, float y);
// Latest face position (normalized -1..1 from center) and its age in ms.
bool faceCameraLatest(float &x, float &y, uint32_t &ageMs);
// Smallest free stack the capture task has had, in bytes (-1 without a camera).
int faceCameraStackFree();
// "off", "unavailable", "searching" or "face", for status reports.
const char *faceCameraState();
