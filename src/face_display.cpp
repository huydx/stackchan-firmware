#include "face_display.h"
#include <M5Unified.h>
#include <string.h>
#include "grobot_eyes.h"

// The eyes and mouth animate in a sprite over the top of the screen; the
// status text below is redrawn only when it changes.
static constexpr int CANVAS_H = 184;
static constexpr float SCALE = 1.2f;
static SemaphoreHandle_t viewLock;
static FaceView shared;

static const MoodData &moodFor(const char *expression) {
    if (!strcmp(expression, "happy")) return MOOD_HAPPY;
    if (!strcmp(expression, "angry")) return MOOD_ANGRY;
    if (!strcmp(expression, "sad")) return MOOD_SAD;
    if (!strcmp(expression, "sleepy")) return MOOD_SLEEPY;
    return MOOD_NEUTRAL;
}

static void faceTask(void *) {
    static M5Canvas canvas(&M5.Display);
    canvas.setPsram(true);
    if (!canvas.createSprite(M5.Display.width(), CANVAS_H)) {
        Serial.println("[bot] face sprite allocation failed");
        vTaskDelete(nullptr);
    }
    GrobotEyes eyes;
    FaceView view;
    char shownStatus[40] = "", shownExpression[12] = "";
    uint32_t last = millis(), nextGlance = 0;
    for (;;) {
        xSemaphoreTake(viewLock, portMAX_DELAY);
        view = shared;
        xSemaphoreGive(viewLock);
        const uint32_t now = millis();
        const float dt = min(0.05f, (now - last) / 1000.0f);
        last = now;

        if (strcmp(view.expression, shownExpression)) {
            strlcpy(shownExpression, view.expression, sizeof shownExpression);
            eyes.setEmotion(moodFor(view.expression));
        }
        // Same color language as the body lights and earlier face.
        eyes.setColor(!view.ready ? 0xFD20 : view.muted ? 0x7BEF : 0x5F7F);
        if (view.looking) {
            eyes.lookAt(view.lookX * 28, view.lookY * 16);
            nextGlance = now + 2500;
        } else if (int32_t(now - nextGlance) >= 0) {
            // Idle: an occasional glance, mostly back to center.
            const bool center = rand() % 3;
            eyes.lookAt(center ? 0 : float(rand() % 41 - 20), center ? 0 : float(rand() % 21 - 10));
            nextGlance = now + 2000 + rand() % 4000;
        }
        eyes.render(canvas, dt, SCALE, view.speaking ? view.mouth : -1);
        M5.Display.startWrite();
        canvas.pushSprite(0, 0);
        if (strcmp(view.status, shownStatus)) {
            strlcpy(shownStatus, view.status, sizeof shownStatus);
            M5.Display.fillRect(0, CANVAS_H, M5.Display.width(), M5.Display.height() - CANVAS_H, TFT_BLACK);
            M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
            M5.Display.setTextDatum(m5gfx::textdatum_t::middle_center);
            M5.Display.drawString(shownStatus, M5.Display.width() / 2, 207);
            M5.Display.setTextColor(0x7BEF, TFT_BLACK);
            M5.Display.drawString("Tap: mute microphone", M5.Display.width() / 2, 229);
        }
        M5.Display.endWrite();
        delay(40);  // about 25 frames a second
    }
}

bool faceDisplayBegin() {
    viewLock = xSemaphoreCreateMutex();
    M5.Display.fillScreen(TFT_BLACK);
    return viewLock && xTaskCreatePinnedToCore(faceTask, "face", 6144, nullptr, 1, nullptr, 0) == pdPASS;
}

void faceDisplayUpdate(const FaceView &view) {
    if (!viewLock) return;
    xSemaphoreTake(viewLock, portMAX_DELAY);
    shared = view;
    xSemaphoreGive(viewLock);
}
