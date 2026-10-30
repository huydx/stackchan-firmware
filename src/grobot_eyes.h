#pragma once
// Spring-physics robot eyes, ported from Grobot_Animations to M5GFX sprites.
// https://github.com/tanmaywankar/Grobot_Animations
//
// MIT License. Copyright (c) 2026 tanmay_wankar
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright
// notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
//
// Changes from the original: draws on an M5GFX sprite with a fixed scale,
// springs the eye positions (not the sprite) so text stays put, adds a sleepy
// mood, a speaking mouth and color changes.
#include <M5GFX.h>
#include <stdlib.h>

struct MoodData {
    float topH, botH, tilt, pR, radius;  // lid, lower lid, brow tilt, pupil, eye radius
};

static constexpr MoodData MOOD_NEUTRAL = {0, 0, 0, 30, 45};
static constexpr MoodData MOOD_HAPPY = {0, 50, 0, 30, 45};
static constexpr MoodData MOOD_ANGRY = {0, 0, 60, 30, 45};
static constexpr MoodData MOOD_SAD = {0, 0, -60, 27, 45};
static constexpr MoodData MOOD_SLEEPY = {48, 0, 0, 24, 45};

class GrobotEyes {
public:
    void setEmotion(const MoodData &mood) {
        base = mood;
        target = mood;
    }

    // Eye offset in design pixels; springs toward it.
    void lookAt(float x, float y) {
        lookX = x;
        lookY = y;
    }

    void setColor(uint16_t color) { eyeColor = color; }

    // Draws one frame. dt in seconds; mouth 0..1 (negative hides it).
    void render(LGFX_Sprite &canvas, float dt, float scale, float mouth) {
        blink();
        spring(posX, velX, lookX, dt, 140, 18);
        spring(posY, velY, lookY, dt, 140, 18);
        spring(current.topH, vel.topH, target.topH, dt);
        spring(current.botH, vel.botH, target.botH, dt);
        spring(current.tilt, vel.tilt, target.tilt, dt);
        spring(current.pR, vel.pR, target.pR, dt, 180, 22);
        spring(current.radius, vel.radius, target.radius, dt);

        canvas.fillSprite(BG);
        const int cx = canvas.width() / 2 + int(posX * scale), cy = int(EYE_Y * scale + posY * scale);
        const int offset = int((45 + 20) * scale);
        drawEye(canvas, cx - offset, cy, scale, true);
        drawEye(canvas, cx + offset, cy, scale, false);
        if (mouth >= 0) {
            const int w = int(26 * scale), h = int((3 + mouth * 22) * scale);
            canvas.fillRoundRect(cx - w / 2, int(MOUTH_Y * scale + posY * scale * 0.5f) - h / 2, w, h, h / 2 < 6 ? h / 2 : 6, eyeColor);
        }
    }

private:
    static constexpr uint16_t BG = 0x0000;
    static constexpr float EYE_Y = 62, MOUTH_Y = 128;
    MoodData current = MOOD_NEUTRAL, target = MOOD_NEUTRAL, base = MOOD_NEUTRAL, vel = {0, 0, 0, 0, 0};
    float posX = 0, posY = 0, velX = 0, velY = 0, lookX = 0, lookY = 0;
    uint16_t eyeColor = 0x97E0;
    uint32_t lastBlink = 0, blinkTime = 3000, blinkDelay = 200;

    static void spring(float &value, float &velocity, float goal, float dt, float stiffness = 180, float damping = 15) {
        velocity += ((goal - value) * stiffness - velocity * damping) * dt;
        value += velocity * dt;
    }

    void blink() {
        const uint32_t now = millis();
        if (now - lastBlink > blinkTime) target.topH = 100;
        if (now - lastBlink > blinkTime + blinkDelay) {
            target.topH = base.topH;
            lastBlink = now;
            blinkDelay = 200 + rand() % 200;
            blinkTime = 4000 + rand() % 11000;
        }
    }

    void drawEye(LGFX_Sprite &canvas, int x, int y, float scale, bool left) {
        const int r = int(current.radius * scale), pupil = int(current.pR * scale);
        const int lid = int(current.topH * scale), bottom = int(current.botH * scale), tilt = int(current.tilt * scale);
        canvas.fillCircle(x, y, r, eyeColor);
        if (pupil > 0) canvas.fillCircle(x, y, pupil, BG);
        if (lid > 0) canvas.fillRect(x - r, y - r, r * 2 + 10, lid, BG);
        // The brow's point sits toward the nose when angry, outward when sad.
        const int point = (left == (tilt < 0)) ? x - r : x + r;
        canvas.fillTriangle(x - r, y - r + lid, x + r, y - r + lid, point, y - r + lid + abs(tilt), BG);
        if (bottom > 0) canvas.fillRect(x - r - 5, y + r + 5 - bottom, r * 2 + 10, bottom, BG);
    }
};
