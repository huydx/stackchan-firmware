#include "face_camera.h"
#include <M5Unified.h>
#include <atomic>
#include <driver/i2c.h>
#include <esp_camera.h>
#include <img_converters.h>

// CoreS3 GC0308 wiring, from m5stack/M5CoreS3 (utility/GC0308.cpp).
static camera_config_t cameraConfig() {
    camera_config_t config = {};
    config.pin_pwdn = config.pin_reset = config.pin_xclk = -1;
    config.pin_sccb_sda = 12;
    config.pin_sccb_scl = 11;
    config.pin_d7 = 47; config.pin_d6 = 48; config.pin_d5 = 16; config.pin_d4 = 15;
    config.pin_d3 = 42; config.pin_d2 = 41; config.pin_d1 = 40; config.pin_d0 = 39;
    config.pin_vsync = 46;
    config.pin_href = 38;
    config.pin_pclk = 45;
    config.xclk_freq_hz = 20000000;
    config.ledc_timer = LEDC_TIMER_0;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.pixel_format = PIXFORMAT_RGB565;
    config.frame_size = FRAMESIZE_QVGA;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;
    config.sccb_i2c_port = -1;
    return config;
}

static constexpr int SNAP_W = 160, SNAP_H = 120;
static std::atomic<bool> enabled{true}, available{false};
static std::atomic<int32_t> faceX{0}, faceY{0};  // thousandths
static std::atomic<uint32_t> faceAt{0};
static SemaphoreHandle_t slotLock;
static TaskHandle_t captureHandle = nullptr;
static uint8_t *slot = nullptr;
static size_t slotLength = 0;

// Half-resolution grayscale from big-endian RGB565; plenty for face detection.
static void downsample(const uint8_t *rgb565, int width, uint8_t *gray) {
    for (int y = 0; y < SNAP_H; ++y) {
        for (int x = 0; x < SNAP_W; ++x) {
            const uint8_t *pixel = rgb565 + ((2 * y) * width + 2 * x) * 2;
            const unsigned r = pixel[0] & 0xf8, g = ((pixel[0] & 7) << 5 | (pixel[1] >> 3)) << 2, b = (pixel[1] & 0x1f) << 3;
            gray[y * SNAP_W + x] = (r * 77 + g * 150 + b * 29) >> 8;
        }
    }
}

static void captureTask(void *) {
    static uint8_t gray[SNAP_W * SNAP_H];
    for (;;) {
        delay(300);  // about three snapshots a second at most
        xSemaphoreTake(slotLock, portMAX_DELAY);
        const bool full = slot != nullptr;
        xSemaphoreGive(slotLock);
        if (!enabled || full) continue;
        camera_fb_t *frame = esp_camera_fb_get();
        if (!frame) continue;
        if (frame->width >= 2 * SNAP_W && frame->height >= 2 * SNAP_H) downsample(frame->buf, frame->width, gray);
        esp_camera_fb_return(frame);
        uint8_t *jpeg = nullptr;
        size_t jpegLength = 0;
        if (!fmt2jpg(gray, sizeof gray, SNAP_W, SNAP_H, PIXFORMAT_GRAYSCALE, 60, &jpeg, &jpegLength)) continue;
        auto *message = static_cast<uint8_t *>(malloc(jpegLength + 4));
        if (message) {
            memcpy(message, "FRM1", 4);
            memcpy(message + 4, jpeg, jpegLength);
            xSemaphoreTake(slotLock, portMAX_DELAY);
            slot = message;
            slotLength = jpegLength + 4;
            xSemaphoreGive(slotLock);
        }
        free(jpeg);
    }
}

bool faceCameraBegin() {
    // The camera driver installs its own I2C driver on the internal bus for
    // sensor setup only. Hand the bus back to M5Unified afterwards; frames
    // arrive over the parallel camera interface, not I2C.
    M5.In_I2C.release();
    // The driver's cam_task has a fixed 2 KB stack, and its occasional frame
    // overflow warnings overflow it while formatting (a stack canary panic).
    // Silencing its tags makes the logger return before any formatting.
    esp_log_level_set("cam_hal", ESP_LOG_NONE);
    esp_log_level_set("ll_cam", ESP_LOG_NONE);
    esp_log_level_set("camera", ESP_LOG_NONE);
    camera_config_t config = cameraConfig();
    const esp_err_t error = esp_camera_init(&config);
    i2c_driver_delete(I2C_NUM_1);
    M5.In_I2C.begin();
    if (error != ESP_OK) {
        Serial.printf("[bot] camera unavailable: %s\n", esp_err_to_name(error));
        return false;
    }
    slotLock = xSemaphoreCreateMutex();
    // Measured peak use is about 2.2 KB; the rest is headroom (see cameraStackFree in status).
    if (!slotLock || xTaskCreatePinnedToCore(captureTask, "camera", 20480, nullptr, 1, &captureHandle, 0) != pdPASS) return false;
    available = true;
    Serial.println("[bot] camera ready for face tracking");
    return true;
}

void faceCameraSetEnabled(bool value) { enabled = value; }

int faceCameraStackFree() { return captureHandle ? int(uxTaskGetStackHighWaterMark(captureHandle)) : -1; }

bool faceCameraTakeFrame(uint8_t *&message, size_t &length) {
    if (!available) return false;
    xSemaphoreTake(slotLock, portMAX_DELAY);
    message = slot;
    length = slotLength;
    slot = nullptr;
    xSemaphoreGive(slotLock);
    return message != nullptr;
}

void faceCameraSetFace(float x, float y) {
    faceX = int32_t(x * 1000);
    faceY = int32_t(y * 1000);
    faceAt = millis();
}

bool faceCameraLatest(float &x, float &y, uint32_t &ageMs) {
    const uint32_t at = faceAt;
    if (!available || !enabled || !at) return false;
    x = faceX / 1000.0f;
    y = faceY / 1000.0f;
    ageMs = millis() - at;
    return true;
}

const char *faceCameraState() {
    if (!available) return "unavailable";
    if (!enabled) return "off";
    const uint32_t at = faceAt;
    return at && millis() - at < 1500 ? "face" : "searching";
}
